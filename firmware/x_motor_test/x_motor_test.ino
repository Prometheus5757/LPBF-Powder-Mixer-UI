/*
  X motor + panel test - Arduino Mega 2560 + RAMPS 1.4 + A4988 in the X socket.

  Motor:   runs 10 s, rests 5 s, repeats 5 times, then stays off.
  LCD:     16x2 on the I2C header (SDA D20, SCL D21), address 0x27 or 0x3F found automatically.
           Line 1 shows the cycle, phase and rpm. Line 2 shows the four pots in %, or the
           latest event for a moment.
  Pots:    A5, A9, A10, A11 (AUX-2). Changes are printed to Serial and shown on the LCD.
  Buttons: red D40, green D42 (AUX-2, active HIGH with 10k pull-downs). Presses are
           printed to Serial and shown on the LCD.
  Serial Monitor: 115200 baud.

  Speed: the A4988 moves the motor one (micro)step per pulse on its STEP pin, so speed is
  set by the pulse rate:
      pulses per second = motor RPM / 60 * 200 full steps * MICROSTEPS
  The pulses come from Timer1 in the background, so the LCD, pots and buttons can be
  serviced without disturbing the motor speed.
  MICROSTEPS must match the jumpers under the X driver: all 3 fitted = 16, none = 1.

  Before powering on: 12 V into the RAMPS power input (USB alone cannot move the motor),
  and only plug or unplug the motor with the power off.
*/

#include <Wire.h>
#include <stdio.h>
#include <string.h>

// ---- settings you can change ----
const float MOTOR_RPM   = 180.0;   // motor shaft speed. With the 5.18:1 gearbox the output turns about 34.7 rpm
const int   MICROSTEPS  = 16;      // 16 if all three MS jumpers are fitted under the X driver, 1 if none are
const unsigned long RUN_MS  = 10000;  // on for 10 s
const unsigned long REST_MS = 5000;   // off for 5 s
const int   CYCLES      = 5;
const bool  REVERSE     = false;   // flip to change direction
const float GEAR_RATIO  = 5.18;    // 17HS15-1684S-PG5 planetary gearbox, used only for the display

// ---- RAMPS 1.4 pins (from the panel wiring) ----
const int X_STEP = 54;   // A0
const int X_DIR  = 55;   // A1
const int X_EN   = 38;   // LOW = driver on, HIGH = driver off
const int POT_PIN[4] = {A5, A9, A10, A11};
const char *const POT_NAME[4] = {"A5", "A9", "A10", "A11"};
const int BTN_RED   = 40;
const int BTN_GREEN = 42;

// ---- input tuning ----
const int POT_REPORT_COUNTS = 10;     // ~1% of travel before a change is reported
const unsigned long DEBOUNCE_MS = 30;
const unsigned long EVENT_SHOW_MS = 1500;
const unsigned long LCD_PERIOD_MS = 150;

// =============================================================== step pulses (Timer1)
volatile uint8_t *stepPort;
uint8_t stepMask;

ISR(TIMER1_COMPA_vect) {
  *stepPort |= stepMask;
  delayMicroseconds(2);                 // A4988 needs at least 1 us high
  *stepPort &= ~stepMask;
}

void setupStepTimer(float stepsPerSecond) {
  // Timer1 in CTC mode. Prescaler 8 gives 0.5 us ticks; slow speeds fall back to prescaler 64.
  uint32_t ticks = (uint32_t)(2000000.0 / stepsPerSecond + 0.5);
  uint8_t prescaleBits = _BV(CS11);
  if (ticks > 65535) { ticks = (uint32_t)(250000.0 / stepsPerSecond + 0.5); prescaleBits = _BV(CS11) | _BV(CS10); }
  if (ticks > 65535) ticks = 65535;
  if (ticks < 20) ticks = 20;           // cap at 100 kHz
  noInterrupts();
  TCCR1A = 0;
  TCCR1B = _BV(WGM12) | prescaleBits;
  OCR1A = ticks - 1;
  TIMSK1 = 0;                           // pulses off until motorOn()
  interrupts();
}

void motorOn() {
  digitalWrite(X_EN, LOW);
  delay(2);
  noInterrupts(); TCNT1 = 0; TIMSK1 |= _BV(OCIE1A); interrupts();
}

void motorOff() {
  noInterrupts(); TIMSK1 &= ~_BV(OCIE1A); interrupts();
  digitalWrite(X_STEP, LOW);
  digitalWrite(X_EN, HIGH);             // driver off, motor free and cool
}

// =============================================================== LCD (HD44780 via PCF8574 backpack)
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
    raw(0x00); delay(5);
    nibble(0x03, 0); delayMicroseconds(4500);
    nibble(0x03, 0); delayMicroseconds(4500);
    nibble(0x03, 0); delayMicroseconds(200);
    nibble(0x02, 0);                    // 4-bit mode
    cmd(0x28);                          // 2 lines, 5x8 font
    cmd(0x0C);                          // display on, cursor off
    cmd(0x01); delay(2);                // clear
    cmd(0x06);                          // entry mode
    memset(shown, ' ', sizeof(shown));
    return true;
  }
  // writes only the characters that changed since last time
  void show(const char *l0, const char *l1) {
    if (!ok) return;
    const char *lines[2] = {l0, l1};
    for (uint8_t r = 0; r < 2; r++) {
      bool padding = false;
      int8_t cursor = -1;
      for (uint8_t c = 0; c < 16; c++) {
        if (!lines[r][c]) padding = true;
        char ch = padding ? ' ' : lines[r][c];
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

// =============================================================== buttons
struct Button {
  int pin;
  const char *name;
  bool stable;
  bool last;
  unsigned long t;
  // true once per debounced press (active HIGH)
  bool pressed() {
    bool r = digitalRead(pin) == HIGH;
    unsigned long now = millis();
    if (r != last) { last = r; t = now; }
    if (now - t > DEBOUNCE_MS && r != stable) { stable = r; return r; }
    return false;
  }
};
Button red   = {BTN_RED, "RED", false, false, 0};
Button green = {BTN_GREEN, "GREEN", false, false, 0};

// =============================================================== state
enum Phase { RUN, REST, DONE };
Phase phase = RUN;
int cycle = 1;
unsigned long phaseStart = 0;
float potFilt[4];
int potReported[4];
char eventMsg[17] = "";
unsigned long eventUntil = 0;
unsigned long lastLcd = 0;

void showEvent(const char *msg) {
  strncpy(eventMsg, msg, 16);
  eventMsg[16] = 0;
  eventUntil = millis() + EVENT_SHOW_MS;
}

int potPercent(int raw) { return (int)((raw * 100L + 511) / 1023); }

// takes a plain int: the IDE's auto-generated prototypes can't see the Phase enum
void startPhase(int p) {
  phase = (Phase)p;
  phaseStart = millis();
  if (p == RUN) {
    motorOn();
    Serial.print(F("Cycle ")); Serial.print(cycle); Serial.print(F(" of ")); Serial.print(CYCLES);
    Serial.println(F(": running"));
  } else {
    motorOff();
    if (p == REST) Serial.println(F("  resting"));
    else Serial.println(F("Done. Motor stays off until reset. Pots and buttons stay live."));
  }
}

void updateMotor() {
  unsigned long elapsed = millis() - phaseStart;
  if (phase == RUN && elapsed >= RUN_MS) {
    if (cycle < CYCLES) startPhase(REST);
    else startPhase(DONE);
  } else if (phase == REST && elapsed >= REST_MS) {
    cycle++;
    startPhase(RUN);
  }
}

void readPots() {
  for (int i = 0; i < 4; i++) {
    potFilt[i] += (analogRead(POT_PIN[i]) - potFilt[i]) * 0.3;
    int raw = (int)(potFilt[i] + 0.5);
    if (abs(raw - potReported[i]) >= POT_REPORT_COUNTS || (raw == 0 && potReported[i] != 0) || (raw == 1023 && potReported[i] != 1023)) {
      potReported[i] = raw;
      Serial.print(F("Pot ")); Serial.print(i + 1);
      Serial.print(F(" (")); Serial.print(POT_NAME[i]); Serial.print(F("): "));
      Serial.print(raw); Serial.print(F(" raw, ")); Serial.print(potPercent(raw)); Serial.println('%');
      char msg[17];
      snprintf(msg, sizeof(msg), "P%d %-3s %4d %3d%%", i + 1, POT_NAME[i], raw, potPercent(raw));   // e.g. "P2 A9   512  50%"
      showEvent(msg);
    }
  }
}

void readButtons() {
  Button *buttons[2] = {&red, &green};
  for (Button *b : buttons) {
    if (b->pressed()) {
      Serial.print(b->name); Serial.print(F(" button pressed (D")); Serial.print(b->pin); Serial.println(')');
      char msg[17];
      snprintf(msg, sizeof(msg), "%s pressed", b->name);
      showEvent(msg);
    }
  }
}

void updateLcd() {
  char l0[17], l1[17];
  unsigned long elapsed = millis() - phaseStart;
  if (phase == RUN) {
    snprintf(l0, sizeof(l0), "C%d/%d RUN %4drpm", cycle, CYCLES, (int)(MOTOR_RPM + 0.5));
  } else if (phase == REST) {
    snprintf(l0, sizeof(l0), "C%d/%d REST %3lus", cycle, CYCLES, (REST_MS - elapsed + 999) / 1000);
  } else {
    snprintf(l0, sizeof(l0), "TEST DONE %dx", CYCLES);
  }
  if (eventMsg[0] && millis() < eventUntil) {
    snprintf(l1, sizeof(l1), "%s", eventMsg);
  } else {
    eventMsg[0] = 0;
    snprintf(l1, sizeof(l1), "%3d%%%3d%%%3d%%%3d%%",
             potPercent(potReported[0]), potPercent(potReported[1]), potPercent(potReported[2]), potPercent(potReported[3]));
  }
  lcd.show(l0, l1);
}

// =============================================================== setup / loop
void setup() {
  Serial.begin(115200);
  pinMode(X_STEP, OUTPUT);
  pinMode(X_DIR, OUTPUT);
  pinMode(X_EN, OUTPUT);
  digitalWrite(X_STEP, LOW);
  digitalWrite(X_DIR, REVERSE ? HIGH : LOW);
  digitalWrite(X_EN, HIGH);                    // motor off until the first run
  stepPort = portOutputRegister(digitalPinToPort(X_STEP));
  stepMask = digitalPinToBitMask(X_STEP);
  pinMode(BTN_RED, INPUT);                     // external 10k pull-downs on the breadboard
  pinMode(BTN_GREEN, INPUT);

  for (int i = 0; i < 4; i++) {
    potFilt[i] = analogRead(POT_PIN[i]);
    potReported[i] = (int)potFilt[i];
  }

  Wire.begin();
  if (lcd.begin()) {
    Serial.print(F("LCD found at 0x")); Serial.println(lcd.addr, HEX);
    lcd.show("LPBF panel test", "X motor + inputs");
  } else {
    Serial.println(F("LCD not found at 0x27 or 0x3F. Check GND, VCC, SDA (D20), SCL (D21)."));
  }

  float stepsPerSecond = MOTOR_RPM / 60.0 * 200.0 * MICROSTEPS;
  setupStepTimer(stepsPerSecond);
  Serial.print(F("X motor test: ")); Serial.print(MOTOR_RPM, 0);
  Serial.print(F(" motor rpm (about ")); Serial.print(MOTOR_RPM / GEAR_RATIO, 1);
  Serial.print(F(" rpm at the gearbox output), ")); Serial.print(stepsPerSecond, 0);
  Serial.println(F(" steps/s"));
  Serial.println(F("Turn a pot or press a button to see it reported."));

  delay(1500);
  startPhase(RUN);
}

void loop() {
  updateMotor();
  readButtons();
  readPots();
  if (millis() - lastLcd >= LCD_PERIOD_MS) {
    lastLcd = millis();
    updateLcd();
  }
  delay(5);
}
