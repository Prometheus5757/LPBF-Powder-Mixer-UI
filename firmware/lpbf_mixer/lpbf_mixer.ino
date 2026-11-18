/*
  LPBF Powder Mixer - panel firmware
  Arduino Mega 2560 + RAMPS 1.4, four A4988 drivers (X, Y, Z, E0),
  four ratio pots on AUX-2, red NEXT button (D40), green GO button (D42),
  16x2 LCD on a PCF8574 I2C backpack (D20/D21).

  Dispense workflow (same from the panel or from the web UI):
    SETUP    Motor N is selected. Pot N sets its ratio (0-100). RED confirms it and
             moves on. After motor 4 is confirmed the system is READY.
    READY    GREEN starts a timed run. RED goes back to motor 1 to edit again.
    RUNNING  Each motor turns at a speed proportional to its ratio. The largest ratio
             runs at the configured top speed. RED (or STOP from the UI) aborts.
    DONE     GREEN repeats the run. RED goes back to motor 1.

  Clean (from the UI): CLEANING spins the chosen motors at the project's maximum speed
  (180 motor rpm, 34.7 rpm at the gearbox output) until STOP or the RED button.
  The previous state comes back afterwards. The UI sends KA every second; if nothing arrives
  for 5 s while cleaning (page closed, cable pulled) the board stops the motors itself.

  Ratios are independent 0-100 values. They are normalised into shares at run time.
  Open loop: there is no feedback. Revolutions are counted from issued steps.

  Step pulses: each motor has its own 16-bit timer (X=T1, Y=T3, Z=T4, E0=T5) in CTC mode,
  so every motor gets an exact, jitter-free step rate.

  Serial: 115200 baud, newline-terminated text commands in, one JSON object per line out.
    PING | STATUS | SET m v | SEL m | NEXT | GO | STOP | RESET | CLEAN mask | KA (heartbeat)
    DUR seconds | TOP rpm_x10 | MS microsteps | GEAR ratio_x100 | INV mask
*/

#include <Arduino.h>
#include <Wire.h>
#include <EEPROM.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>

#define FW_VERSION "0.2.0"

// ---------------------------------------------------------------- hardware map
const uint8_t STEP_PIN[4] = {54, 60, 46, 26};   // X, Y, Z, E0
const uint8_t DIR_PIN[4]  = {55, 61, 48, 28};
const uint8_t EN_PIN[4]   = {38, 56, 62, 24};   // active LOW on the A4988
const uint8_t POT_PIN[4]  = {A5, A9, A10, A11};
const uint8_t BTN_NEXT_PIN = 40;                // left, red  (active HIGH, 10k pull-down)
const uint8_t BTN_GO_PIN   = 42;                // right, green

// ---------------------------------------------------------------- tuning
const float    MAX_MOTOR_RPM     = 180.0f;  // project limit, motor shaft (34.7 rpm after the 5.18:1 gearbox)
const float    MAX_STEP_HZ       = 12000.0f;// per motor, keeps ISR load sensible
const uint16_t RAMP_MS           = 400;     // linear speed ramp at start
const uint16_t STATUS_PERIOD_MS  = 200;
const uint16_t STATUS_MIN_GAP_MS = 60;
const uint16_t LCD_PERIOD_MS     = 120;
const uint16_t FLASH_MS          = 1600;
const int      TAKEOVER_COUNTS   = 30;      // ~3 % of pot travel before the dial takes over
const uint16_t DEBOUNCE_MS       = 30;
const float    FULL_STEPS_PER_REV = 200.0f;
const uint16_t HOST_TIMEOUT_MS   = 5000;    // cleaning stops if the UI goes quiet this long

// ---------------------------------------------------------------- persistent config
struct Config {
  uint16_t magic;
  uint16_t durationS;   // run length, seconds
  uint16_t topRpm10;    // output-shaft rpm x10 for the largest ratio
  uint8_t  microsteps;  // must match MS1-3 jumpers under the drivers
  uint16_t gear100;     // gearbox ratio x100 (PG5 = 518)
  uint8_t  invMask;     // bit n set = reverse motor n
};
const uint16_t CFG_MAGIC = 0x4C51;
Config cfg;

void loadConfig() {
  EEPROM.get(0, cfg);
  if (cfg.magic != CFG_MAGIC || cfg.microsteps == 0 || cfg.gear100 == 0) {
    cfg.magic = CFG_MAGIC;
    cfg.durationS = 60;
    cfg.topRpm10 = 200;
    cfg.microsteps = 16;
    cfg.gear100 = 518;
    cfg.invMask = 0;
    EEPROM.put(0, cfg);
  }
}
void saveConfig() { EEPROM.put(0, cfg); }

float gear() { return cfg.gear100 / 100.0f; }
float stepsPerMotorRev() { return FULL_STEPS_PER_REV * cfg.microsteps; }
float stepsPerRev() { return stepsPerMotorRev() * gear(); }          // per output revolution
float maxMotorRpm() {                                                  // project limit or step-rate limit
  float byStep = MAX_STEP_HZ * 60.0f / stepsPerMotorRev();
  return byStep < MAX_MOTOR_RPM ? byStep : MAX_MOTOR_RPM;
}
float maxRpm() { return maxMotorRpm() / gear(); }                     // output shaft

// ---------------------------------------------------------------- step generators (one timer per motor)
struct StepTimer {
  volatile uint8_t *tccrA, *tccrB, *timsk;
  volatile uint16_t *ocrA, *tcnt;
};
const StepTimer TMR[4] = {
  {&TCCR1A, &TCCR1B, &TIMSK1, &OCR1A, &TCNT1},
  {&TCCR3A, &TCCR3B, &TIMSK3, &OCR3A, &TCNT3},
  {&TCCR4A, &TCCR4B, &TIMSK4, &OCR4A, &TCNT4},
  {&TCCR5A, &TCCR5B, &TIMSK5, &OCR5A, &TCNT5},
};
volatile uint8_t *stepReg[4];
uint8_t stepMask[4];
volatile uint32_t stepCount[4];

static inline void stepPulse(uint8_t i) {
  *stepReg[i] |= stepMask[i];
  delayMicroseconds(2);                       // A4988 needs at least 1 us high
  *stepReg[i] &= ~stepMask[i];
  stepCount[i]++;
}
ISR(TIMER1_COMPA_vect) { stepPulse(0); }
ISR(TIMER3_COMPA_vect) { stepPulse(1); }
ISR(TIMER4_COMPA_vect) { stepPulse(2); }
ISR(TIMER5_COMPA_vect) { stepPulse(3); }

// set motor i to a step rate in Hz (0 = no pulses)
void setRate(uint8_t i, float hz) {
  const StepTimer &t = TMR[i];
  uint8_t sreg = SREG;
  cli();
  if (hz < 1.0f) { *t.timsk &= ~_BV(OCIE1A); SREG = sreg; return; }
  if (hz > MAX_STEP_HZ) hz = MAX_STEP_HZ;
  uint8_t cs; float base;                     // bit positions are the same on timers 1/3/4/5
  if (hz >= 2000000.0f / 65535.0f)     { cs = _BV(CS11);              base = 2000000.0f; }  // /8
  else if (hz >= 250000.0f / 65535.0f) { cs = _BV(CS11) | _BV(CS10);  base = 250000.0f; }   // /64
  else                                 { cs = _BV(CS12);              base = 62500.0f; }    // /256
  uint32_t ticks = (uint32_t)(base / hz + 0.5f);
  if (ticks < 2) ticks = 2;
  if (ticks > 65535) ticks = 65535;
  *t.tccrA = 0;
  *t.tccrB = _BV(WGM12) | cs;                 // CTC on OCRnA
  *t.ocrA = ticks - 1;
  if (*t.tcnt >= ticks - 1) *t.tcnt = 0;      // avoid a wrap-around pause when slowing down
  *t.timsk |= _BV(OCIE1A);
  SREG = sreg;
}

uint32_t readSteps(uint8_t i) { noInterrupts(); uint32_t s = stepCount[i]; interrupts(); return s; }

// motion shared by timed runs and cleaning
float targetHz[4] = {0, 0, 0, 0};
uint32_t motionStartMs = 0;
bool rampDone = true;

void startMotion(const float hz[4]) {
  for (uint8_t i = 0; i < 4; i++) {
    setRate(i, 0);
    targetHz[i] = hz[i];
    digitalWrite(DIR_PIN[i], (cfg.invMask >> i) & 1 ? HIGH : LOW);
    digitalWrite(EN_PIN[i], hz[i] > 0 ? LOW : HIGH);
  }
  noInterrupts(); for (uint8_t i = 0; i < 4; i++) stepCount[i] = 0; interrupts();
  delay(2);                                   // let the drivers wake up
  motionStartMs = millis();
  rampDone = false;
}

void stopMotion() {
  for (uint8_t i = 0; i < 4; i++) { setRate(i, 0); targetHz[i] = 0; }
  delayMicroseconds(50);                      // let the last pulse finish
  for (uint8_t i = 0; i < 4; i++) digitalWrite(EN_PIN[i], HIGH);
  rampDone = true;
}

void serviceRamp() {
  if (rampDone) return;
  uint32_t t = millis() - motionStartMs;
  float k = t >= RAMP_MS ? 1.0f : (float)t / RAMP_MS;
  for (uint8_t i = 0; i < 4; i++) setRate(i, targetHz[i] * k);
  if (k >= 1.0f) rampDone = true;
}

// ---------------------------------------------------------------- LCD (HD44780 via PCF8574)
class I2cLcd {
 public:
  bool ok = false;
  uint8_t addr = 0;
  bool begin() {
    const uint8_t candidates[] = {0x27, 0x3F};
    for (uint8_t a : candidates) {
      Wire.beginTransmission(a);
      if (Wire.endTransmission() == 0) { addr = a; ok = true; break; }
    }
    if (!ok) return false;
    delay(50);
    raw(0x00);
    delay(5);
    nibble(0x03, 0); delayMicroseconds(4500);
    nibble(0x03, 0); delayMicroseconds(4500);
    nibble(0x03, 0); delayMicroseconds(200);
    nibble(0x02, 0);                     // 4-bit mode
    cmd(0x28);                           // 2 lines, 5x8
    cmd(0x0C);                           // display on, no cursor
    cmd(0x01); delay(2);                 // clear
    cmd(0x06);                           // entry mode
    memset(shown, ' ', sizeof(shown));
    return true;
  }
  // write only the characters that changed
  void show(const char *l0, const char *l1) {
    if (!ok) return;
    const char *lines[2] = {l0, l1};
    for (uint8_t r = 0; r < 2; r++) {
      int8_t cursor = -1;
      for (uint8_t c = 0; c < 16; c++) {
        char ch = lines[r][c] ? lines[r][c] : ' ';
        if (ch == shown[r][c]) { cursor = -1; continue; }
        if (cursor != (int8_t)c) cmd(0x80 | (c + (r ? 0x40 : 0)));
        data(ch);
        shown[r][c] = ch;
        cursor = c + 1;
      }
    }
  }
 private:
  char shown[2][16];
  static const uint8_t BL = 0x08, EN = 0x04, RS = 0x01;
  void raw(uint8_t d) { Wire.beginTransmission(addr); Wire.write(d | BL); Wire.endTransmission(); }
  void nibble(uint8_t n, uint8_t mode) {
    uint8_t d = (n << 4) | mode | BL;
    Wire.beginTransmission(addr);
    Wire.write(d); Wire.write(d | EN); Wire.write(d);
    Wire.endTransmission();
  }
  void cmd(uint8_t v)  { nibble(v >> 4, 0);  nibble(v & 0x0F, 0); }
  void data(uint8_t v) { nibble(v >> 4, RS); nibble(v & 0x0F, RS); }
};
I2cLcd lcd;

// ---------------------------------------------------------------- state
enum State : uint8_t { ST_SETUP, ST_READY, ST_RUNNING, ST_DONE, ST_CLEANING };
const char *const STATE_NAME[] = {"SETUP", "READY", "RUNNING", "DONE", "CLEANING"};

State state = ST_SETUP;
State resumeState = ST_SETUP;      // where CLEANING returns to
uint8_t active = 0;
uint8_t confirmedMask = 0;
uint8_t value[4] = {0, 0, 0, 0};
bool potOwns[4] = {false, false, false, false};
int lockRaw[4];
float potFilt[4];
uint8_t potPct[4];
bool aborted = false;
uint32_t runStartMs = 0, runElapsedMs = 0;
uint16_t runRpm10[4] = {0, 0, 0, 0};
uint16_t topEff10 = 0;
float runRev[4] = {0, 0, 0, 0};    // last run, snapshotted when it ends
uint8_t cleanMask = 0;
uint32_t cleanStartMs = 0, cleanElapsedMs = 0;
float cleanRev[4] = {0, 0, 0, 0};  // last cleaning pass
char lcdLine[2][17];
char flashMsg[17] = "";
uint32_t flashUntil = 0;
bool dirty = true;
uint32_t lastStatusMs = 0, lastLcdMs = 0;

bool busy() { return state == ST_RUNNING || state == ST_CLEANING; }
void markDirty() { dirty = true; }
void flash(const char *m) { strncpy(flashMsg, m, 16); flashMsg[16] = 0; flashUntil = millis() + FLASH_MS; markDirty(); }

void lockPot(uint8_t i) { potOwns[i] = false; lockRaw[i] = (int)potFilt[i]; }

uint16_t sumValues() { return (uint16_t)value[0] + value[1] + value[2] + value[3]; }
uint8_t sharePct(uint8_t i) {
  uint16_t s = sumValues();
  return s ? (uint8_t)((value[i] * 100UL + s / 2) / s) : 0;
}
float cleanMotorRpm() { return maxMotorRpm(); }

// ---------------------------------------------------------------- dispense run
void startRun() {
  uint8_t maxV = 0;
  for (uint8_t i = 0; i < 4; i++) if (value[i] > maxV) maxV = value[i];
  if (maxV == 0) { flash("All ratios are 0"); return; }
  float spr = stepsPerRev();
  float top = cfg.topRpm10 / 10.0f;
  float lim = maxRpm();
  if (top > lim) top = lim;
  topEff10 = (uint16_t)(top * 10.0f + 0.5f);
  float hz[4];
  for (uint8_t i = 0; i < 4; i++) {
    float rpm = top * value[i] / maxV;
    runRpm10[i] = (uint16_t)(rpm * 10.0f + 0.5f);
    hz[i] = rpm * spr / 60.0f;
  }
  startMotion(hz);
  runStartMs = motionStartMs;
  runElapsedMs = 0;
  aborted = false;
  state = ST_RUNNING;
  markDirty();
}

void finishRun(bool abort) {
  stopMotion();
  runElapsedMs = millis() - runStartMs;
  if (!abort && runElapsedMs > (uint32_t)cfg.durationS * 1000UL) runElapsedMs = (uint32_t)cfg.durationS * 1000UL;
  float spr = stepsPerRev();
  for (uint8_t i = 0; i < 4; i++) runRev[i] = readSteps(i) / spr;
  aborted = abort;
  state = ST_DONE;
  markDirty();
}

void serviceRun() {
  if (state != ST_RUNNING) return;
  runElapsedMs = millis() - runStartMs;
  if (runElapsedMs >= (uint32_t)cfg.durationS * 1000UL) finishRun(false);
}

// ---------------------------------------------------------------- cleaning
bool startClean(uint8_t mask) {
  if (busy() || mask == 0 || mask > 15) return false;
  float hz[4];
  float motorHz = cleanMotorRpm() / 60.0f * stepsPerMotorRev();
  for (uint8_t i = 0; i < 4; i++) hz[i] = (mask >> i) & 1 ? motorHz : 0;
  resumeState = state;
  cleanMask = mask;
  startMotion(hz);
  cleanStartMs = motionStartMs;
  cleanElapsedMs = 0;
  state = ST_CLEANING;
  Serial.print(F("{\"t\":\"ev\",\"e\":\"clean_start\",\"mask\":")); Serial.print(mask); Serial.println('}');
  markDirty();
  return true;
}

void stopClean(const char *src) {
  stopMotion();
  cleanElapsedMs = millis() - cleanStartMs;
  float spr = stepsPerRev();
  for (uint8_t i = 0; i < 4; i++) cleanRev[i] = readSteps(i) / spr;
  state = resumeState;
  if (state == ST_SETUP) lockPot(active);     // don't let a dial jump the value on return
  Serial.print(F("{\"t\":\"ev\",\"e\":\"clean_stop\",\"src\":\"")); Serial.print(src); Serial.println(F("\"}"));
  markDirty();
}

uint32_t lastHostMs = 0;   // last line received from the UI (it sends KA every second)

void serviceClean() {
  if (state != ST_CLEANING) return;
  cleanElapsedMs = millis() - cleanStartMs;
  // cleaning has no end time, so never let it outlive the page that started it
  if (millis() - lastHostMs > HOST_TIMEOUT_MS) { stopClean("timeout"); flash("Host lost: stop"); }
}

// ---------------------------------------------------------------- actions (panel and serial share these)
int8_t nextUnconfirmed() {
  for (uint8_t k = 1; k <= 4; k++) {
    uint8_t i = (active + k) % 4;
    if (!(confirmedMask & (1 << i))) return i;
  }
  return -1;
}

void actNext(const char *src) {
  if (state == ST_CLEANING) { stopClean(src); return; }   // red stops cleaning
  switch (state) {
    case ST_SETUP: {
      confirmedMask |= (1 << active);
      int8_t n = nextUnconfirmed();
      if (n < 0) state = ST_READY;
      else { active = n; lockPot(active); }
      break;
    }
    case ST_READY:
    case ST_DONE:
      state = ST_SETUP; confirmedMask = 0; active = 0; lockPot(0);
      break;
    case ST_RUNNING:
      finishRun(true);
      break;
    default:
      break;
  }
  Serial.print(F("{\"t\":\"ev\",\"e\":\"next\",\"src\":\"")); Serial.print(src); Serial.println(F("\"}"));
  markDirty();
}

void actGo(const char *src) {
  Serial.print(F("{\"t\":\"ev\",\"e\":\"go\",\"src\":\"")); Serial.print(src); Serial.println(F("\"}"));
  if (state == ST_READY || state == ST_DONE) startRun();
  else if (state == ST_SETUP) flash("Confirm M1-M4");
}

bool actSel(uint8_t m) {
  if (busy()) return false;
  state = ST_SETUP; active = m; lockPot(m); markDirty();
  return true;
}

bool actSet(uint8_t m, uint8_t v) {
  if (busy()) return false;
  value[m] = v;
  if (state == ST_SETUP && m == active) lockPot(m);
  markDirty();
  return true;
}

bool actReset() {
  if (busy()) return false;
  for (uint8_t i = 0; i < 4; i++) { value[i] = 0; runRpm10[i] = 0; runRev[i] = 0; }
  confirmedMask = 0; active = 0; state = ST_SETUP; runElapsedMs = 0; aborted = false;
  lockPot(0);
  markDirty();
  return true;
}

// ---------------------------------------------------------------- inputs
struct Button {
  uint8_t pin;
  bool stable;
  bool last;
  uint32_t t;
  // true once per debounced press (active HIGH)
  bool pressed() {
    bool r = digitalRead(pin) == HIGH;
    uint32_t now = millis();
    if (r != last) { last = r; t = now; }
    if (now - t > DEBOUNCE_MS && r != stable) { stable = r; return r; }
    return false;
  }
};
Button btnNext = {BTN_NEXT_PIN, false, false, 0};
Button btnGo = {BTN_GO_PIN, false, false, 0};

void readPots() {
  for (uint8_t i = 0; i < 4; i++) {
    int raw = analogRead(POT_PIN[i]);
    potFilt[i] += (raw - potFilt[i]) * 0.25f;
    float p = potFilt[i] * 100.0f / 1023.0f;
    if (p < 0) p = 0;
    if (p > 100) p = 100;
    if (fabs(p - potPct[i]) > 0.7f || (p > 99.6f && potPct[i] != 100) || (p < 0.4f && potPct[i] != 0)) {
      potPct[i] = (uint8_t)(p + 0.5f);
      markDirty();
    }
  }
  if (state == ST_SETUP) {
    uint8_t i = active;
    if (!potOwns[i] && abs((int)potFilt[i] - lockRaw[i]) > TAKEOVER_COUNTS) { potOwns[i] = true; markDirty(); }
    if (potOwns[i] && value[i] != potPct[i]) { value[i] = potPct[i]; markDirty(); }
  }
}

// ---------------------------------------------------------------- LCD content
void renderLcd() {
  char *l0 = lcdLine[0], *l1 = lcdLine[1];
  l1[0] = 0;
  switch (state) {
    case ST_SETUP:
      snprintf(l0, 17, "Set M%u:%3u  %3u%%", active + 1, value[active], sharePct(active));
      for (uint8_t i = 0; i < 4; i++) {
        char mark = (i == active) ? '>' : ((confirmedMask >> i) & 1 ? '*' : ' ');
        snprintf(l1 + i * 4, 5, "%c%3u", mark, value[i]);
      }
      break;
    case ST_READY:
      snprintf(l0, 17, "READY %4us  GO>", cfg.durationS);
      for (uint8_t i = 0; i < 4; i++) snprintf(l1 + i * 4, 5, "%3u%%", sharePct(i));
      break;
    case ST_RUNNING:
      snprintf(l0, 17, "RUN %4u/%4us", (unsigned)(runElapsedMs / 1000), cfg.durationS);
      for (uint8_t i = 0; i < 4; i++) snprintf(l1 + i * 4, 5, "%3u%%", sharePct(i));
      break;
    case ST_DONE:
      snprintf(l0, 17, aborted ? "STOPPED %4us" : "DONE    %4us", (unsigned)(runElapsedMs / 1000));
      snprintf(l1, 17, "RED:edit GO:rpt");
      break;
    case ST_CLEANING: {
      snprintf(l0, 17, "CLEANING %3urpm", (unsigned)(cleanMotorRpm() + 0.5f));
      char m[5];
      for (uint8_t i = 0; i < 4; i++) m[i] = (cleanMask >> i) & 1 ? '1' + i : '-';
      m[4] = 0;
      snprintf(l1, 17, "M %s RED=stop", m);
      break;
    }
  }
  if (flashMsg[0] && millis() < flashUntil) snprintf(l1, 17, "%-16s", flashMsg);
  else if (flashMsg[0]) { flashMsg[0] = 0; markDirty(); }
  for (uint8_t r = 0; r < 2; r++) {        // pad to 16
    size_t n = strlen(lcdLine[r]);
    while (n < 16) lcdLine[r][n++] = ' ';
    lcdLine[r][16] = 0;
  }
}

// ---------------------------------------------------------------- status out
void printArr8(const uint8_t *a) { Serial.print('['); for (uint8_t i = 0; i < 4; i++) { if (i) Serial.print(','); Serial.print(a[i]); } Serial.print(']'); }
void printArrF(const float *a) { Serial.print('['); for (uint8_t i = 0; i < 4; i++) { if (i) Serial.print(','); Serial.print(a[i], 3); } Serial.print(']'); }

void sendStatus() {
  uint8_t ownMask = 0;
  for (uint8_t i = 0; i < 4; i++) if (potOwns[i]) ownMask |= (1 << i);
  float spr = stepsPerRev();
  float live[4];
  for (uint8_t i = 0; i < 4; i++) live[i] = readSteps(i) / spr;

  Serial.print(F("{\"t\":\"st\",\"s\":\"")); Serial.print(STATE_NAME[state]);
  Serial.print(F("\",\"a\":")); Serial.print(active);
  Serial.print(F(",\"cm\":")); Serial.print(confirmedMask);
  Serial.print(F(",\"v\":")); printArr8(value);
  Serial.print(F(",\"k\":")); printArr8(potPct);
  Serial.print(F(",\"ko\":")); Serial.print(ownMask);
  Serial.print(F(",\"d\":")); Serial.print(cfg.durationS);
  Serial.print(F(",\"top\":")); Serial.print(cfg.topRpm10);
  Serial.print(F(",\"topEff\":")); Serial.print(topEff10);
  Serial.print(F(",\"max\":")); Serial.print((uint16_t)(maxRpm() * 10.0f));
  Serial.print(F(",\"mmr\":")); Serial.print((uint16_t)(maxMotorRpm() * 10.0f + 0.5f));
  Serial.print(F(",\"ms\":")); Serial.print(cfg.microsteps);
  Serial.print(F(",\"g\":")); Serial.print(cfg.gear100);
  Serial.print(F(",\"inv\":")); Serial.print(cfg.invMask);
  Serial.print(F(",\"el\":")); Serial.print(runElapsedMs);
  Serial.print(F(",\"ab\":")); Serial.print(aborted ? 1 : 0);
  Serial.print(F(",\"rpm\":["));
  for (uint8_t i = 0; i < 4; i++) { if (i) Serial.print(','); Serial.print(runRpm10[i]); }
  Serial.print(F("],\"rev\":")); printArrF(state == ST_RUNNING ? live : runRev);
  Serial.print(F(",\"cl\":")); Serial.print(cleanMask);
  Serial.print(F(",\"cel\":")); Serial.print(cleanElapsedMs);
  Serial.print(F(",\"crev\":")); printArrF(state == ST_CLEANING ? live : cleanRev);
  Serial.print(F(",\"lcd\":[\"")); Serial.print(lcdLine[0]); Serial.print(F("\",\"")); Serial.print(lcdLine[1]);
  Serial.print(F("\"],\"lcdok\":")); Serial.print(lcd.ok ? 1 : 0);
  Serial.println('}');
}

void sendHello() {
  Serial.print(F("{\"t\":\"hello\",\"dev\":\"lpbf-mixer\",\"fw\":\"" FW_VERSION "\",\"lcd\":"));
  Serial.print(lcd.ok ? lcd.addr : 0);
  Serial.println('}');
}

void ack(const char *c) { Serial.print(F("{\"t\":\"ack\",\"c\":\"")); Serial.print(c); Serial.println(F("\"}")); }
void nack(const char *c, const __FlashStringHelper *m) {
  Serial.print(F("{\"t\":\"err\",\"c\":\"")); Serial.print(c); Serial.print(F("\",\"m\":\"")); Serial.print(m); Serial.println(F("\"}"));
}

// ---------------------------------------------------------------- serial commands
char rx[48];
uint8_t rxLen = 0;

void handleCommand(char *line) {
  char *cmd = strtok(line, " \t");
  if (!cmd) return;
  for (char *p = cmd; *p; p++) *p = toupper(*p);
  char *a1 = strtok(nullptr, " \t");
  char *a2 = strtok(nullptr, " \t");
  long n1 = a1 ? atol(a1) : -1;
  long n2 = a2 ? atol(a2) : -1;

  if (!strcmp(cmd, "KA")) return;                 // heartbeat from the UI, no reply
  if (!strcmp(cmd, "PING")) { sendHello(); return; }
  if (!strcmp(cmd, "STATUS")) { renderLcd(); sendStatus(); return; }
  if (!strcmp(cmd, "STOP")) {
    if (state == ST_RUNNING) { finishRun(true); ack(cmd); }
    else if (state == ST_CLEANING) { stopClean("ui"); ack(cmd); }
    else nack(cmd, F("nothing is moving"));
    return;
  }
  if (!strcmp(cmd, "CLEAN")) {
    if (n1 < 1 || n1 > 15) { nack(cmd, F("CLEAN motor bitmask 1-15")); return; }
    if (startClean(n1)) ack(cmd); else nack(cmd, F("stop the current motion first"));
    return;
  }
  if (!strcmp(cmd, "NEXT")) { actNext("ui"); ack(cmd); return; }
  if (!strcmp(cmd, "GO")) { actGo("ui"); ack(cmd); return; }
  if (busy()) { nack(cmd, F("stop the motors first")); return; }
  if (!strcmp(cmd, "RESET")) { actReset(); ack(cmd); return; }
  if (!strcmp(cmd, "SEL")) {
    if (n1 < 1 || n1 > 4) { nack(cmd, F("motor 1-4")); return; }
    actSel(n1 - 1); ack(cmd);
    return;
  }
  if (!strcmp(cmd, "SET")) {
    if (n1 < 1 || n1 > 4 || n2 < 0 || n2 > 100) { nack(cmd, F("SET motor(1-4) value(0-100)")); return; }
    actSet(n1 - 1, n2); ack(cmd);
    return;
  }
  if (!strcmp(cmd, "DUR")) {
    if (n1 < 1 || n1 > 3600) { nack(cmd, F("1-3600 s")); return; }
    cfg.durationS = n1; saveConfig(); markDirty(); ack(cmd); return;
  }
  if (!strcmp(cmd, "TOP")) {
    if (n1 < 1 || n1 > 3000) { nack(cmd, F("rpm x10, 1-3000")); return; }
    cfg.topRpm10 = n1; saveConfig(); markDirty(); ack(cmd); return;
  }
  if (!strcmp(cmd, "MS")) {
    if (n1 != 1 && n1 != 2 && n1 != 4 && n1 != 8 && n1 != 16) { nack(cmd, F("1, 2, 4, 8 or 16")); return; }
    cfg.microsteps = n1; saveConfig(); markDirty(); ack(cmd); return;
  }
  if (!strcmp(cmd, "GEAR")) {
    if (n1 < 100 || n1 > 10000) { nack(cmd, F("ratio x100, 100-10000")); return; }
    cfg.gear100 = n1; saveConfig(); markDirty(); ack(cmd); return;
  }
  if (!strcmp(cmd, "INV")) {
    if (n1 < 0 || n1 > 15) { nack(cmd, F("bitmask 0-15")); return; }
    cfg.invMask = n1; saveConfig(); markDirty(); ack(cmd); return;
  }
  nack(cmd, F("unknown command"));
}

void readSerial() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\r') continue;
    if (c == '\n') { rx[rxLen] = 0; lastHostMs = millis(); if (rxLen) handleCommand(rx); rxLen = 0; continue; }
    if (rxLen < sizeof(rx) - 1) rx[rxLen++] = c;
  }
}

// ---------------------------------------------------------------- setup / loop
void setup() {
  Serial.begin(115200);
  for (uint8_t i = 0; i < 4; i++) {
    pinMode(STEP_PIN[i], OUTPUT); digitalWrite(STEP_PIN[i], LOW);
    pinMode(DIR_PIN[i], OUTPUT);  digitalWrite(DIR_PIN[i], LOW);
    pinMode(EN_PIN[i], OUTPUT);   digitalWrite(EN_PIN[i], HIGH);   // drivers off until motion
    stepReg[i] = portOutputRegister(digitalPinToPort(STEP_PIN[i]));
    stepMask[i] = digitalPinToBitMask(STEP_PIN[i]);
    setRate(i, 0);
  }
  pinMode(BTN_NEXT_PIN, INPUT);
  pinMode(BTN_GO_PIN, INPUT);
  loadConfig();
  for (uint8_t i = 0; i < 4; i++) {
    potFilt[i] = analogRead(POT_PIN[i]);
    potPct[i] = (uint8_t)(potFilt[i] * 100.0f / 1023.0f + 0.5f);
  }
  lockPot(0);
  Wire.begin();
  Wire.setClock(100000);
  lcd.begin();
  if (lcd.ok) { lcd.show("LPBF Powder Mix ", "fw " FW_VERSION "        "); delay(900); }
  sendHello();
}

void loop() {
  readSerial();
  if (btnNext.pressed()) actNext("panel");
  if (btnGo.pressed()) actGo("panel");
  readPots();
  serviceRamp();
  serviceRun();
  serviceClean();

  uint32_t now = millis();
  if (now - lastLcdMs >= LCD_PERIOD_MS) {
    lastLcdMs = now;
    renderLcd();
    lcd.show(lcdLine[0], lcdLine[1]);
  }
  bool periodic = now - lastStatusMs >= STATUS_PERIOD_MS;
  bool early = dirty && now - lastStatusMs >= STATUS_MIN_GAP_MS;
  if (periodic || early) {
    lastStatusMs = now;
    dirty = false;
    renderLcd();
    sendStatus();
  }
}
