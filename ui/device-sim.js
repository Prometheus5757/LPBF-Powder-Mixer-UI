// Simulated panel: same commands, same JSON lines and same state machine as
// firmware/lpbf_mixer/lpbf_mixer.ino (fw 0.2.0), so the UI can be exercised without the Mega.
// Keep the two in step when either changes.

const STATES = ['SETUP', 'READY', 'RUNNING', 'DONE', 'CLEANING'];
const SETUP = 0, READY = 1, RUNNING = 2, DONE = 3, CLEANING = 4;
const MAX_MOTOR_RPM = 180, MAX_STEP_HZ = 12000, RAMP_MS = 400, FLASH_MS = 1600;
const STATUS_PERIOD_MS = 200, STATUS_MIN_GAP_MS = 60, TAKEOVER_COUNTS = 30, HOST_TIMEOUT_MS = 5000;
const CFG_KEY = 'lpbf.sim.cfg';
const FW = '0.2.0-sim';

const pad = (v, w) => String(v).padStart(w, ' ');

export class SimDevice {
  constructor() {
    this.label = 'Simulator';
    this.kind = 'sim';
    this.lineHandlers = [];
    this.closeHandlers = [];
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(CFG_KEY) || 'null'); } catch { /* ignore */ }
    this.cfg = Object.assign({ durationS: 60, topRpm10: 200, microsteps: 16, gear100: 518, invMask: 0 }, saved || {});
    this.potRaw = [0, 0, 0, 0];
    this.potFilt = [0, 0, 0, 0];
    this.potPct = [0, 0, 0, 0];
    this.state = SETUP; this.resume = SETUP; this.active = 0; this.cm = 0;
    this.value = [0, 0, 0, 0];
    this.potOwns = [false, false, false, false];
    this.lockRaw = [0, 0, 0, 0];
    this.aborted = false;
    this.runStart = 0; this.el = 0;
    this.rpm10 = [0, 0, 0, 0]; this.topEff10 = 0;
    this.runRev = [0, 0, 0, 0];
    this.cleanMask = 0; this.cleanStart = 0; this.cel = 0; this.cleanRev = [0, 0, 0, 0];
    this.motorRpm = [0, 0, 0, 0];   // target motor-shaft rpm while moving
    this.live = [0, 0, 0, 0];       // output revolutions since motion started
    this.motionStart = 0;
    this.flashMsg = ''; this.flashUntil = 0;
    this.dirty = true; this.lastStatus = 0;
    this.lcd = ['', ''];
  }

  onLine(fn) { this.lineHandlers.push(fn); }
  onClose(fn) { this.closeHandlers.push(fn); }
  emit(obj) { const line = JSON.stringify(obj); this.lineHandlers.forEach(fn => fn(line)); }
  hello() { this.emit({ t: 'hello', dev: 'lpbf-mixer', fw: FW, lcd: 39 }); }

  async connect() {
    this.last = performance.now();
    this.timer = setInterval(() => this.tick(), 20);
    setTimeout(() => this.hello(), 250);
  }
  async disconnect() { clearInterval(this.timer); this.closeHandlers.forEach(fn => fn()); }

  /* ---- virtual panel inputs ---- */
  setPot(i, raw) { this.potRaw[i] = Math.max(0, Math.min(1023, Math.round(raw))); }
  press(which) { which === 'next' ? this.actNext('panel') : this.actGo('panel'); }

  /* ---- helpers mirrored from firmware ---- */
  gear() { return this.cfg.gear100 / 100; }
  stepsPerMotorRev() { return 200 * this.cfg.microsteps; }
  maxMotorRpm() { return Math.min(MAX_MOTOR_RPM, MAX_STEP_HZ * 60 / this.stepsPerMotorRev()); }
  maxRpm() { return this.maxMotorRpm() / this.gear(); }
  busy() { return this.state === RUNNING || this.state === CLEANING; }
  sum() { return this.value.reduce((a, b) => a + b, 0); }
  share(i) { const s = this.sum(); return s ? Math.floor((this.value[i] * 100 + Math.floor(s / 2)) / s) : 0; }
  saveCfg() { try { localStorage.setItem(CFG_KEY, JSON.stringify(this.cfg)); } catch { /* ignore */ } }
  markDirty() { this.dirty = true; }
  flash(m) { this.flashMsg = m.slice(0, 16); this.flashUntil = performance.now() + FLASH_MS; this.markDirty(); }
  lockPot(i) { this.potOwns[i] = false; this.lockRaw[i] = Math.trunc(this.potFilt[i]); }
  nextUnconfirmed() {
    for (let k = 1; k <= 4; k++) { const i = (this.active + k) % 4; if (!(this.cm & (1 << i))) return i; }
    return -1;
  }

  startMotion(motorRpm) {
    this.motorRpm = motorRpm;
    this.live = [0, 0, 0, 0];
    this.motionStart = performance.now();
  }
  stopMotion() { this.motorRpm = [0, 0, 0, 0]; }

  startRun() {
    const maxV = Math.max(...this.value);
    if (maxV === 0) { this.flash('All ratios are 0'); return; }
    const top = Math.min(this.cfg.topRpm10 / 10, this.maxRpm());
    this.topEff10 = Math.round(top * 10);
    const outRpm = this.value.map(v => top * v / maxV);
    this.rpm10 = outRpm.map(r => Math.round(r * 10));
    this.startMotion(outRpm.map(r => r * this.gear()));
    this.runStart = this.motionStart; this.el = 0; this.aborted = false;
    this.state = RUNNING; this.markDirty();
  }
  finishRun(abort) {
    this.stopMotion();
    this.el = Math.round(performance.now() - this.runStart);
    if (!abort) this.el = Math.min(this.el, this.cfg.durationS * 1000);
    this.runRev = [...this.live];
    this.aborted = abort; this.state = DONE; this.markDirty();
  }

  startClean(mask) {
    if (this.busy() || mask < 1 || mask > 15) return false;
    const rpm = this.maxMotorRpm();
    this.resume = this.state;
    this.cleanMask = mask;
    this.startMotion([0, 1, 2, 3].map(i => (mask >> i) & 1 ? rpm : 0));
    this.cleanStart = this.motionStart; this.cel = 0;
    this.state = CLEANING;
    this.emit({ t: 'ev', e: 'clean_start', mask });
    this.markDirty();
    return true;
  }
  stopClean(src) {
    this.stopMotion();
    this.cel = Math.round(performance.now() - this.cleanStart);
    this.cleanRev = [...this.live];
    this.state = this.resume;
    if (this.state === SETUP) this.lockPot(this.active);
    this.emit({ t: 'ev', e: 'clean_stop', src });
    this.markDirty();
  }

  actNext(src) {
    if (this.state === CLEANING) { this.stopClean(src); return; }
    if (this.state === SETUP) {
      this.cm |= 1 << this.active;
      const n = this.nextUnconfirmed();
      if (n < 0) this.state = READY; else { this.active = n; this.lockPot(n); }
    } else if (this.state === READY || this.state === DONE) {
      this.state = SETUP; this.cm = 0; this.active = 0; this.lockPot(0);
    } else if (this.state === RUNNING) this.finishRun(true);
    this.emit({ t: 'ev', e: 'next', src });
    this.markDirty();
  }
  actGo(src) {
    this.emit({ t: 'ev', e: 'go', src });
    if (this.state === READY || this.state === DONE) this.startRun();
    else if (this.state === SETUP) this.flash('Confirm M1-M4');
  }

  /* ---- serial commands ---- */
  send(line) {
    const parts = line.trim().split(/\s+/);
    const cmd = (parts[0] || '').toUpperCase();
    const n1 = parts[1] !== undefined ? parseInt(parts[1], 10) : -1;
    const n2 = parts[2] !== undefined ? parseInt(parts[2], 10) : -1;
    const ack = () => this.emit({ t: 'ack', c: cmd });
    const nack = m => this.emit({ t: 'err', c: cmd, m });
    this.lastHost = performance.now();
    setTimeout(() => {
      switch (cmd) {
        case 'KA': return;
        case 'PING': return this.hello();
        case 'STATUS': return this.sendStatus();
        case 'STOP':
          if (this.state === RUNNING) { this.finishRun(true); return ack(); }
          if (this.state === CLEANING) { this.stopClean('ui'); return ack(); }
          return nack('nothing is moving');
        case 'CLEAN':
          if (!(n1 >= 1 && n1 <= 15)) return nack('CLEAN motor bitmask 1-15');
          return this.startClean(n1) ? ack() : nack('stop the current motion first');
        case 'NEXT': this.actNext('ui'); return ack();
        case 'GO': this.actGo('ui'); return ack();
      }
      if (this.busy()) return nack('stop the motors first');
      const set = (k, v) => { this.cfg[k] = v; this.saveCfg(); this.markDirty(); ack(); };
      switch (cmd) {
        case 'RESET':
          this.value = [0, 0, 0, 0]; this.rpm10 = [0, 0, 0, 0]; this.runRev = [0, 0, 0, 0];
          this.cm = 0; this.active = 0; this.state = SETUP; this.el = 0; this.aborted = false; this.lockPot(0);
          this.markDirty(); return ack();
        case 'SEL':
          if (n1 < 1 || n1 > 4) return nack('motor 1-4');
          this.state = SETUP; this.active = n1 - 1; this.lockPot(n1 - 1); this.markDirty(); return ack();
        case 'SET':
          if (n1 < 1 || n1 > 4 || n2 < 0 || n2 > 100 || Number.isNaN(n2)) return nack('SET motor(1-4) value(0-100)');
          this.value[n1 - 1] = n2;
          if (this.state === SETUP && n1 - 1 === this.active) this.lockPot(n1 - 1);
          this.markDirty(); return ack();
        case 'DUR': return n1 < 1 || n1 > 3600 ? nack('1-3600 s') : set('durationS', n1);
        case 'TOP': return n1 < 1 || n1 > 3000 ? nack('rpm x10, 1-3000') : set('topRpm10', n1);
        case 'MS': return [1, 2, 4, 8, 16].includes(n1) ? set('microsteps', n1) : nack('1, 2, 4, 8 or 16');
        case 'GEAR': return n1 < 100 || n1 > 10000 ? nack('ratio x100, 100-10000') : set('gear100', n1);
        case 'INV': return n1 < 0 || n1 > 15 ? nack('bitmask 0-15') : set('invMask', n1);
      }
      nack('unknown command');
    }, 4);
  }

  /* ---- main loop ---- */
  tick() {
    const now = performance.now();
    const dt = now - (this.last || now);
    this.last = now;
    for (let i = 0; i < 4; i++) {
      this.potFilt[i] += (this.potRaw[i] - this.potFilt[i]) * 0.25;
      const p = Math.max(0, Math.min(100, this.potFilt[i] * 100 / 1023));
      if (Math.abs(p - this.potPct[i]) > 0.7 || (p > 99.6 && this.potPct[i] !== 100) || (p < 0.4 && this.potPct[i] !== 0)) {
        this.potPct[i] = Math.round(p); this.markDirty();
      }
    }
    if (this.state === SETUP) {
      const i = this.active;
      if (!this.potOwns[i] && Math.abs(Math.trunc(this.potFilt[i]) - this.lockRaw[i]) > TAKEOVER_COUNTS) { this.potOwns[i] = true; this.markDirty(); }
      if (this.potOwns[i] && this.value[i] !== this.potPct[i]) { this.value[i] = this.potPct[i]; this.markDirty(); }
    }
    if (this.busy()) {
      const k = Math.min(1, (now - this.motionStart) / RAMP_MS);
      for (let i = 0; i < 4; i++) this.live[i] += this.motorRpm[i] * k / this.gear() / 60 * dt / 1000;
    }
    if (this.state === RUNNING) {
      this.el = now - this.runStart;
      if (this.el >= this.cfg.durationS * 1000) this.finishRun(false);
    }
    if (this.state === CLEANING) {
      this.cel = now - this.cleanStart;
      if (now - (this.lastHost || now) > HOST_TIMEOUT_MS) { this.stopClean('timeout'); this.flash('Host lost: stop'); }
    }
    const periodic = now - this.lastStatus >= STATUS_PERIOD_MS;
    const early = this.dirty && now - this.lastStatus >= STATUS_MIN_GAP_MS;
    if (periodic || early) { this.lastStatus = now; this.dirty = false; this.sendStatus(); }
  }

  renderLcd() {
    let l0 = '', l1 = '';
    const s = this.state;
    const shares = () => [0, 1, 2, 3].map(i => pad(this.share(i), 3) + '%').join('');
    if (s === SETUP) {
      l0 = `Set M${this.active + 1}:${pad(this.value[this.active], 3)}  ${pad(this.share(this.active), 3)}%`;
      for (let i = 0; i < 4; i++) l1 += (i === this.active ? '>' : (this.cm >> i) & 1 ? '*' : ' ') + pad(this.value[i], 3);
    } else if (s === READY) { l0 = `READY ${pad(this.cfg.durationS, 4)}s  GO>`; l1 = shares(); }
    else if (s === RUNNING) { l0 = `RUN ${pad(Math.floor(this.el / 1000), 4)}/${pad(this.cfg.durationS, 4)}s`; l1 = shares(); }
    else if (s === DONE) { l0 = (this.aborted ? 'STOPPED ' : 'DONE    ') + pad(Math.floor(this.el / 1000), 4) + 's'; l1 = 'RED:edit GO:rpt'; }
    else {
      l0 = `CLEANING ${pad(Math.round(this.maxMotorRpm()), 3)}rpm`;
      l1 = 'M ' + [0, 1, 2, 3].map(i => (this.cleanMask >> i) & 1 ? String(i + 1) : '-').join('') + ' RED=stop';
    }
    if (this.flashMsg && performance.now() < this.flashUntil) l1 = this.flashMsg;
    else if (this.flashMsg) { this.flashMsg = ''; this.markDirty(); }
    this.lcd = [l0.padEnd(16).slice(0, 16), l1.padEnd(16).slice(0, 16)];
  }

  sendStatus() {
    this.renderLcd();
    const ko = this.potOwns.reduce((m, o, i) => m | (o ? 1 << i : 0), 0);
    const r3 = a => a.map(r => Math.round(r * 1000) / 1000);
    this.emit({
      t: 'st', s: STATES[this.state], a: this.active, cm: this.cm, v: [...this.value], k: [...this.potPct], ko,
      d: this.cfg.durationS, top: this.cfg.topRpm10, topEff: this.topEff10, max: Math.floor(this.maxRpm() * 10),
      mmr: Math.round(this.maxMotorRpm() * 10),
      ms: this.cfg.microsteps, g: this.cfg.gear100, inv: this.cfg.invMask,
      el: Math.round(this.el), ab: this.aborted ? 1 : 0, rpm: [...this.rpm10],
      rev: r3(this.state === RUNNING ? this.live : this.runRev),
      cl: this.cleanMask, cel: Math.round(this.cel), crev: r3(this.state === CLEANING ? this.live : this.cleanRev),
      lcd: [...this.lcd], lcdok: 1
    });
  }
}
