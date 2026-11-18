import { SerialLink } from './device-serial.js';
import { SimDevice } from './device-sim.js';
import { Calibration } from './calibration.js';
import { DocsView } from './docs.js';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, d = 1) => (Number.isFinite(n) ? n.toFixed(d) : '—');

const MOTORS = [
  { drv: 'X', pot: 'Pot 1 · A5' },
  { drv: 'Y', pot: 'Pot 2 · A9' },
  { drv: 'Z', pot: 'Pot 3 · A10' },
  { drv: 'E0', pot: 'Pot 4 · A11' }
];
const COLOR_VARS = ['--m1', '--m2', '--m3', '--m4'];

const cal = new Calibration();
let link = null;        // SerialLink or SimDevice
let st = null;          // last status line from the device
let hello = null;
let lastStatusAt = 0;
const vals = [0, 0, 0, 0];          // ratios as shown (device values plus local edits in flight)
const localEditAt = [0, 0, 0, 0];
const pendingSet = [null, null, null, null];
const setTimers = [null, null, null, null];
let trialKey = null;
let trialSavedKey = null;
let prevState = null;

// cleaning: which dispensers are picked, and a short history of passes (kept in this browser)
const CLEAN_SEL_KEY = 'lpbf.clean.sel', CLEAN_HIST_KEY = 'lpbf.clean.history';
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d; } catch { return d; } };
const store = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } };
let cleanSel = load(CLEAN_SEL_KEY, [true, false, false, false]);
let cleanHist = load(CLEAN_HIST_KEY, []);
let cleanStartedAt = null;
let cleanStopSrc = null;
const busyState = s => s === 'RUNNING' || s === 'CLEANING';
const mmss = ms => { const s = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/* ======================================================= connection */

function setConn(state, text) {
  $('connPill').dataset.state = state;
  $('connText').textContent = text;
  const on = state !== 'off';
  $('btnConnect').hidden = on;
  $('btnSim').hidden = on;
  $('btnDisconnect').hidden = !on;
  $('app').dataset.conn = state === 'on' || state === 'sim' ? 'on' : 'off';
}

function notice(msg) {
  const n = $('notice');
  n.textContent = msg || '';
  n.hidden = !msg;
}

function attach(dev) {
  link = dev;
  st = null; hello = null;
  dev.onLine(onLine);
  dev.onClose(() => {
    if (link !== dev) return;
    link = null; st = null; hello = null;
    setConn('off', 'Not connected');
    $('simPanel').hidden = true;
    log('sys', 'Disconnected');
    render();
  });
}

async function connectSerial(knownPort) {
  if (link) return;
  notice('');
  if (!SerialLink.supported()) {
    notice('This browser cannot open USB serial ports. Use Chrome or Edge, and open the page from http://localhost (run start-ui.bat).');
    return;
  }
  const dev = new SerialLink();
  try { await dev.connect(knownPort); }
  catch (e) {
    if (e && e.name !== 'NotFoundError') notice(`Could not open the port: ${e.message}`);
    return;
  }
  attach(dev);
  setConn('wait', 'Waiting for the Mega…');
  log('sys', `Opened ${dev.label}. The Mega resets when the port opens.`);
  // the Mega reboots on open; ping until it answers
  [1600, 3200, 5000].forEach(t => setTimeout(() => { if (link === dev && !hello) send('PING', true); }, t));
  setTimeout(() => {
    if (link === dev && !hello && $('connText').textContent !== 'Wrong sketch on the board') notice('The port is open but the board is not answering. Check that firmware/lpbf_mixer is uploaded and nothing else (the Arduino IDE serial monitor) is using the port.');
  }, 6500);
}

async function connectSim() {
  if (link) return;
  notice('');
  const dev = new SimDevice();
  attach(dev);
  setConn('wait', 'Starting simulator…');
  await dev.connect();
  $('simPanel').hidden = false;
  buildSimPots();
  log('sys', 'Simulator started. The virtual panel stands in for the dials and buttons.');
}

async function disconnect() {
  const dev = link;
  if (!dev) return;
  if (busyState(st?.s)) { send('STOP'); await new Promise(r => setTimeout(r, 150)); }
  await dev.disconnect();
}

function send(cmd, quiet = false) {
  if (!link) return;
  if (!quiet) log('tx', cmd);
  link.send(cmd);
}

function onLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch {
    log('rx', line);
    // plain text before any hello means a different sketch is on the board
    // (a half-received JSON line from the reset still starts with "{", so it doesn't count)
    if (!hello && link?.kind === 'serial' && !line.trimStart().startsWith('{')) {
      setConn('wait', 'Wrong sketch on the board');
      notice(`The board is running a different sketch. It printed "${line.slice(0, 60)}". Upload firmware/lpbf_mixer/lpbf_mixer.ino to the Mega, then connect again.`);
    }
    return;
  }
  switch (msg.t) {
    case 'st':
      st = msg; lastStatusAt = performance.now();
      if (prevState === 'CLEANING' && st.s !== 'CLEANING') recordCleanPass();
      if (st.s === 'CLEANING' && prevState !== 'CLEANING') cleanStartedAt = cleanStartedAt || new Date().toISOString();
      prevState = st.s;
      mergeValues();
      render();
      break;
    case 'hello':
      hello = msg;
      setConn(link?.kind === 'sim' ? 'sim' : 'on', `${link?.kind === 'sim' ? 'Simulator' : 'Mega connected'} · fw ${msg.fw}`);
      notice('');
      log('sys', `Board answered: ${msg.dev} firmware ${msg.fw}, LCD ${msg.lcd ? '0x' + Number(msg.lcd).toString(16).toUpperCase() : 'not found'}`);
      if (!msg.lcd && link?.kind !== 'sim') notice('The Mega did not find the LCD on I²C address 0x27 or 0x3F. Check the four I²C wires. The UI still works.');
      send('STATUS', true);
      break;
    case 'ev':
      if (msg.e === 'clean_start') {
        cleanStartedAt = new Date().toISOString();
        log('ev', `Cleaning started on ${maskNames(msg.mask)}`);
      } else if (msg.e === 'clean_stop') {
        cleanStopSrc = msg.src;
        log(msg.src === 'timeout' ? 'err' : 'ev', `Cleaning stopped ${{ panel: 'with the red button', ui: 'from this UI', timeout: 'by the board: it lost contact with this page' }[msg.src] || ''}`);
      } else {
        log('ev', `${msg.e === 'next' ? 'Red' : 'Green'} button (${msg.src === 'panel' ? 'on the panel' : 'from this UI'})`);
      }
      break;
    case 'err':
      log('err', `${msg.c}: ${msg.m}`);
      break;
    case 'ack':
      break;
    default:
      log('rx', line);
  }
}

function maskNames(mask) {
  return [0, 1, 2, 3].filter(i => (mask >> i) & 1).map(i => cal.name(i)).join(', ') || 'none';
}

function recordCleanPass() {
  cleanHist.unshift({
    at: cleanStartedAt || new Date().toISOString(),
    mask: st.cl,
    ms: st.cel,
    rev: st.crev.filter((r, i) => (st.cl >> i) & 1).reduce((a, b) => a + b, 0),
    by: { panel: 'Red button', ui: 'Stop in UI', timeout: 'Lost connection' }[cleanStopSrc] || 'Stop in UI'
  });
  cleanHist = cleanHist.slice(0, 25);
  store(CLEAN_HIST_KEY, cleanHist);
  cleanStartedAt = null;
  cleanStopSrc = null;
  renderCleanHistory();
}

// device values win unless the operator is mid-edit on that motor
function mergeValues() {
  const now = performance.now();
  for (let i = 0; i < 4; i++) {
    const editing = document.activeElement === $(`num${i}`) || now - localEditAt[i] < 700 || pendingSet[i] !== null;
    if (!editing) vals[i] = st.v[i];
  }
}

/* ======================================================= ratio edits */

function setLocal(i, v, final) {
  v = Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
  vals[i] = v;
  localEditAt[i] = performance.now();
  pendingSet[i] = v;
  if (final) {
    clearTimeout(setTimers[i]);
    setTimers[i] = null;
    flushSet(i, false);
  } else if (!setTimers[i]) {
    // while dragging: send now, then at most every 80 ms
    flushSet(i, true);
    setTimers[i] = setTimeout(() => { setTimers[i] = null; flushSet(i, true); }, 80);
  }
  render();
}

function flushSet(i, quiet) {
  const v = pendingSet[i];
  if (v === null) return;
  pendingSet[i] = null;
  send(`SET ${i + 1} ${v}`, quiet);
}

/* ======================================================= build */

function buildMotors() {
  const wrap = $('motors');
  wrap.innerHTML = '';
  MOTORS.forEach((m, i) => {
    const el = document.createElement('article');
    el.className = 'motor';
    el.dataset.i = i;
    el.id = `motor${i}`;
    el.innerHTML = `
      <div class="id">
        <input class="name" id="name${i}" value="${esc(cal.name(i))}" aria-label="Name of canister ${i + 1}" maxlength="24">
        <div class="meta">Motor ${i + 1} · ${m.drv} driver · ${m.pot}</div>
        <div class="badges"><span class="badge" id="badge${i}">Waiting</span><span class="badge src" id="src${i}" hidden></span></div>
      </div>
      <div class="ctrl">
        <div class="slider">
          <div class="track"></div><div class="fill" id="fill${i}"></div>
          <div class="knob" id="knob${i}" data-label="dial" hidden></div>
          <input type="range" min="0" max="100" step="1" value="0" id="rng${i}" aria-label="Ratio for canister ${i + 1}">
        </div>
        <div class="scale"><span>0</span><span>25</span><span>50</span><span>75</span><span>100</span></div>
      </div>
      <div class="readout">
        <div class="valbox"><input type="number" min="0" max="100" step="1" value="0" id="num${i}" inputmode="numeric" aria-label="Ratio value for canister ${i + 1}"><small>Ratio</small></div>
        <div class="sharebox"><b id="share${i}">0%</b><small>Share</small></div>
        <button class="btn small" id="sel${i}" title="Make this the motor the dial and red button act on">Select</button>
      </div>
      <div class="live" id="live${i}"></div>`;
    wrap.appendChild(el);
    $(`rng${i}`).addEventListener('input', e => setLocal(i, e.target.value, false));
    $(`rng${i}`).addEventListener('change', e => setLocal(i, e.target.value, true));
    $(`num${i}`).addEventListener('change', e => setLocal(i, e.target.value, true));
    $(`num${i}`).addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
    $(`sel${i}`).addEventListener('click', () => send(`SEL ${i + 1}`));
    $(`name${i}`).addEventListener('change', e => {
      cal.setName(i, e.target.value);
      e.target.value = cal.name(i);
      renderCalibration(); renderCleanHistory(); render();
    });
  });
}

function buildSteps() {
  const items = ['Motor 1', 'Motor 2', 'Motor 3', 'Motor 4', 'Ready', 'Run'];
  $('steps').innerHTML = items.map((t, k) => `<li id="step${k}" class="${k === 5 ? 'step-run' : ''}"><b>${t}</b><span id="stepSub${k}">—</span></li>`).join('');
}

function buildInv() {
  $('invChecks').innerHTML = MOTORS.map((m, i) => `<label><input type="checkbox" id="inv${i}"> M${i + 1} (${m.drv})</label>`).join('');
  for (let i = 0; i < 4; i++) $(`inv${i}`).addEventListener('change', () => {
    let mask = 0;
    for (let k = 0; k < 4; k++) if ($(`inv${k}`).checked) mask |= 1 << k;
    send(`INV ${mask}`);
  });
}

function buildSimPots() {
  $('simPots').innerHTML = MOTORS.map((m, i) => `
    <div class="sim-pot">
      <label for="pot${i}">Pot ${i + 1}</label>
      <input type="range" id="pot${i}" min="0" max="1023" value="0">
      <output id="potOut${i}">0</output>
    </div>`).join('');
  for (let i = 0; i < 4; i++) $(`pot${i}`).addEventListener('input', e => {
    link?.setPot?.(i, Number(e.target.value));
    $(`potOut${i}`).textContent = e.target.value;
  });
}

/* ======================================================= render */

function computePlan() {
  const s = st?.s;
  const maxV = Math.max(...vals);
  const top = st ? Math.min(st.top, st.max) / 10 : 0;
  const dur = st ? st.d : 0;
  const ran = s === 'RUNNING' || s === 'DONE';
  return vals.map((v, i) => {
    const rpm = ran ? st.rpm[i] / 10 : (maxV ? top * v / maxV : 0);
    const plannedRevs = ran ? rpm * dur / 60 : rpm * dur / 60;
    const revs = ran ? st.rev[i] : plannedRevs;
    const gpr = rpm > 0 ? cal.gramsPerRev(i, rpm) : null;
    const mass = gpr !== null ? revs * gpr : null;
    return { v, rpm, revs, plannedRevs, gpr, mass };
  });
}

function shares() {
  const sum = vals.reduce((a, b) => a + b, 0);
  return vals.map(v => (sum ? v * 100 / sum : 0));
}

function render() {
  const s = st?.s || 'OFFLINE';
  const online = !!st;
  const running = s === 'RUNNING';
  const busy = busyState(s);
  $('app').dataset.s = s;
  const sh = shares();
  const plan = computePlan();
  const names = [0, 1, 2, 3].map(i => cal.name(i));

  /* steps */
  for (let k = 0; k < 6; k++) {
    const li = $(`step${k}`);
    let cls = k === 5 ? 'step-run' : '';
    let sub = '—';
    if (online) {
      if (k < 4) {
        const confirmed = (st.cm >> k) & 1;
        const now = s === 'SETUP' && st.a === k;
        if (now) { cls += ' now'; sub = 'Editing'; }
        else if (confirmed || s === 'READY' || s === 'RUNNING' || s === 'DONE') { cls += ' done'; sub = `${vals[k]}`; }
        else sub = 'Waiting';
      } else if (k === 4) {
        if (s === 'READY') { cls += ' now'; sub = 'Press green'; }
        else if (running || s === 'DONE') { cls += ' done'; sub = 'Set'; }
      } else {
        if (running) { cls += ' now'; sub = `${Math.floor(st.el / 1000)} / ${st.d} s`; }
        else if (s === 'DONE') { cls += st.ab ? '' : ' done'; sub = st.ab ? 'Stopped' : 'Complete'; }
      }
    }
    li.className = cls.trim();
    $(`stepSub${k}`).textContent = sub;
  }

  /* share bar */
  const sum = vals.reduce((a, b) => a + b, 0);
  $('shareBar').innerHTML = sum
    ? vals.map((v, i) => v ? `<span style="flex-grow:${v};background:var(${COLOR_VARS[i]})" title="${esc(names[i])}: ${sh[i].toFixed(1)}%">${sh[i] >= 7 ? Math.round(sh[i]) + '%' : ''}</span>` : '').join('')
    : '<span class="empty-note">All ratios are at 0</span>';
  $('shareBar').setAttribute('aria-label', 'Mix shares: ' + names.map((n, i) => `${n} ${Math.round(sh[i])}%`).join(', '));
  $('shareLegend').innerHTML = names.map((n, i) => `<span><i style="background:var(${COLOR_VARS[i]})"></i>${esc(n)} <b>${sh[i].toFixed(1)}%</b></span>`).join('');

  /* motors */
  for (let i = 0; i < 4; i++) {
    const active = online && s === 'SETUP' && st.a === i;
    const confirmed = online && ((st.cm >> i) & 1);
    $(`motor${i}`).classList.toggle('active', active);
    const badge = $(`badge${i}`);
    badge.className = 'badge' + (active ? ' editing' : confirmed ? ' ok' : '');
    badge.textContent = !online ? 'Offline' : active ? 'Editing' : confirmed ? 'Confirmed' : s === 'SETUP' ? 'Waiting' : 'Set';
    const src = $(`src${i}`);
    src.hidden = !active;
    if (active) src.textContent = (st.ko >> i) & 1 ? `Dial ${i + 1} in control` : `Turn dial ${i + 1} to take over`;
    const rng = $(`rng${i}`), num = $(`num${i}`);
    if (document.activeElement !== rng) rng.value = vals[i];
    if (document.activeElement !== num) num.value = vals[i];
    rng.disabled = num.disabled = !online || busy;
    $(`sel${i}`).disabled = !online || busy || active;
    $(`fill${i}`).style.width = `${vals[i]}%`;
    $(`share${i}`).textContent = `${Math.round(sh[i])}%`;
    const knob = $(`knob${i}`);
    knob.hidden = !online;
    if (online) { knob.style.left = `calc(${st.k[i]}% * (100% - 20px) / 100% + 10px)`; knob.dataset.label = `dial ${st.k[i]}`; }
    const p = plan[i];
    $(`live${i}`).innerHTML = online && (running || s === 'DONE')
      ? `<span>Speed <b>${fmt(p.rpm)} rpm</b></span><span>Revolutions <b>${fmt(p.revs, 2)}</b> of ${fmt(p.plannedRevs, 2)}</span><span>Est. mass <b>${p.mass !== null ? fmt(p.mass, 2) + ' g' : 'not calibrated'}</b></span>`
      : '';
    const nameIn = $(`name${i}`);
    if (document.activeElement !== nameIn) nameIn.value = names[i];
  }

  /* panel */
  const lcd = $('lcd');
  const lines = online ? st.lcd : ['', ''];
  lcd.classList.toggle('off', !online);
  lcd.innerHTML = lines.map(l => l.padEnd(16).slice(0, 16)).join('').split('').map(c => `<span>${c === ' ' ? '&nbsp;' : esc(c)}</span>`).join('');
  lcd.setAttribute('aria-label', online ? `LCD: ${lines[0].trim()} / ${lines[1].trim()}` : 'LCD off');
  const chip = $('stateChip');
  chip.dataset.s = s;
  chip.textContent = { OFFLINE: 'Offline', SETUP: 'Setup', READY: 'Ready', RUNNING: 'Running', DONE: st?.ab ? 'Stopped' : 'Done', CLEANING: 'Cleaning' }[s];

  let hint = 'Connect the Mega over USB, or start the simulator to try the workflow.';
  let nextLabel = 'Confirm motor 1';
  if (online) {
    const a = st.a;
    const othersLeft = [0, 1, 2, 3].some(k => k !== a && !((st.cm >> k) & 1));
    if (s === 'SETUP') {
      hint = `Motor ${a + 1} · ${names[a]}: turn dial ${a + 1} or type a ratio, then press red to ${othersLeft ? 'confirm and move to the next motor' : 'confirm and finish setup'}.`;
      nextLabel = othersLeft ? `Confirm motor ${a + 1}, next` : `Confirm motor ${a + 1}, finish`;
    } else if (s === 'READY') {
      hint = sum ? `All four ratios are set. Press green to start a ${st.d} s run, or red to edit them again.` : 'All four ratios are 0. Press red to edit them before starting.';
      nextLabel = 'Edit ratios';
    } else if (running) {
      hint = 'Dispensing. Red or Stop ends the run early.';
      nextLabel = 'Stop run';
    } else if (s === 'DONE') {
      hint = `${st.ab ? `Run stopped after ${fmt(st.el / 1000)} s.` : 'Run complete.'} Green repeats it with the same ratios, and red goes back to editing.`;
      nextLabel = 'Edit ratios';
    } else if (s === 'CLEANING') {
      hint = `Cleaning ${maskNames(st.cl)} at full speed. Red or Stop ends it.`;
      nextLabel = 'Stop cleaning';
    }
  }
  $('hint').textContent = hint;
  $('nextLabel').textContent = nextLabel;
  const canGo = online && (s === 'READY' || s === 'DONE') && sum > 0;
  $('btnNext').disabled = !online;
  $('btnGo').disabled = !canGo;
  $('btnGo').classList.toggle('armed', canGo);
  $('goLabel').textContent = s === 'DONE' ? 'Run again' : 'Start run';
  $('btnReset').disabled = !online || busy;

  /* run card */
  const dur = $('inDur'), top = $('inTop');
  if (online) {
    if (document.activeElement !== dur) dur.value = st.d;
    if (document.activeElement !== top) top.value = (st.top / 10).toFixed(1);
    const capped = st.top > st.max;
    $('topNote').textContent = capped
      ? `Capped at ${fmt(st.max / 10)} rpm by the step rate at 1/${st.ms} microstepping.`
      : `Up to ${fmt(st.max / 10)} rpm at 1/${st.ms} microstepping.`;
  } else $('topNote').textContent = '';
  dur.disabled = top.disabled = !online || busy;
  $('btnStop').hidden = !running;
  const frac = online && (running || s === 'DONE') ? Math.min(1, st.el / (st.d * 1000)) : 0;
  $('runBar').style.width = `${(frac * 100).toFixed(1)}%`;
  $('runBar').parentElement.classList.toggle('aborted', s === 'DONE' && !!st?.ab);
  $('runStateText').textContent = !online ? 'Offline' : running ? 'Dispensing' : s === 'DONE' ? (st.ab ? 'Stopped early' : 'Complete') : 'Not running';
  $('runTimeText').textContent = online && (running || s === 'DONE') ? `${fmt(st.el / 1000)} / ${st.d} s` : online ? `${st.d} s planned` : '';

  /* plan table */
  const masses = plan.map(p => p.mass);
  const used = plan.map((p, i) => vals[i] > 0);
  const massKnown = used.some(Boolean) && used.every((u, i) => !u || masses[i] !== null);
  const massTotal = massKnown ? masses.reduce((a, m, i) => a + (used[i] ? m : 0), 0) : null;
  $('planBody').innerHTML = plan.map((p, i) => `
    <tr>
      <td><span class="sw" style="background:var(${COLOR_VARS[i]})"></span>${esc(names[i])}</td>
      <td class="num">${p.v}</td>
      <td class="num">${sh[i].toFixed(1)}%</td>
      <td class="num">${fmt(p.rpm)} rpm</td>
      <td class="num">${running || s === 'DONE' ? `${fmt(p.revs, 2)} <span class="dim">/ ${fmt(p.plannedRevs, 2)}</span>` : fmt(p.revs, 2)}</td>
      <td class="num">${p.mass !== null ? fmt(p.mass, 2) + ' g' : '<span class="dim">—</span>'}</td>
      <td class="num">${massKnown && used[i] && massTotal > 0 ? (p.mass / massTotal * 100).toFixed(1) + '%' : '<span class="dim">—</span>'}</td>
    </tr>`).join('');
  const revTotal = plan.reduce((a, p) => a + p.revs, 0);
  $('planFoot').innerHTML = `<tr><td>Total</td><td class="num">${sum}</td><td class="num">${sum ? '100%' : '0%'}</td><td></td>
    <td class="num">${fmt(revTotal, 2)}</td><td class="num">${massTotal !== null ? fmt(massTotal, 2) + ' g' : '<span class="dim">—</span>'}</td><td></td></tr>`;

  renderTrial();

  /* settings */
  if (online) {
    if (document.activeElement !== $('inMs')) $('inMs').value = String(st.ms);
    if (document.activeElement !== $('inGear')) $('inGear').value = (st.g / 100).toFixed(2);
    for (let i = 0; i < 4; i++) $(`inv${i}`).checked = !!((st.inv >> i) & 1);
  }
  ['inMs', 'inGear'].forEach(id => { $(id).disabled = !online || busy; });
  for (let i = 0; i < 4; i++) $(`inv${i}`).disabled = !online || busy;
  const spr = online ? 200 * st.ms * st.g / 100 : null;
  $('facts').innerHTML = `
    <dt>Steps per output revolution</dt><dd>${spr ? fmt(spr, 0) : '—'}</dd>
    <dt>Maximum speed (cleaning)</dt><dd>${online ? `${fmt(st.mmr / 10, 0)} motor · ${fmt(st.max / 10)} output rpm` : '—'}</dd>
    <dt>Firmware</dt><dd>${hello ? esc(hello.fw) : '—'}</dd>
    <dt>LCD</dt><dd>${hello ? (hello.lcd ? '0x' + Number(hello.lcd).toString(16).toUpperCase() : 'not found') : '—'}</dd>`;

  renderClean();
  renderMotionBar();
  updateViewer();
}

/* ======================================================= clean */

const ROTOR_SVG = `<svg class="rotor" viewBox="0 0 64 64" aria-hidden="true">
  <circle cx="32" cy="32" r="29" fill="none" stroke="var(--line-strong)" stroke-width="2"/>
  <g class="hub">
    <path d="M32 32 L32 6 A26 26 0 0 1 54.5 19 Z" fill="var(--c)" opacity=".85"/>
    <path d="M32 32 L54.5 45 A26 26 0 0 1 32 58 Z" fill="var(--c)" opacity=".55"/>
    <path d="M32 32 L9.5 45 A26 26 0 0 1 9.5 19 Z" fill="var(--c)" opacity=".7"/>
  </g>
  <circle cx="32" cy="32" r="6" fill="var(--surface)" stroke="var(--ink)" stroke-width="2"/>
</svg>`;

function buildCleanTiles() {
  $('cleanMotors').innerHTML = MOTORS.map((m, i) => `
    <button class="clean-tile" data-i="${i}" id="ct${i}" aria-pressed="false">
      ${ROTOR_SVG}
      <b id="ctName${i}"></b>
      <small>Motor ${i + 1} · ${m.drv} driver</small>
      <small id="ctRev${i}">&nbsp;</small>
      <span class="check" id="ctCheck${i}">Not selected</span>
    </button>`).join('');
  for (let i = 0; i < 4; i++) $(`ct${i}`).addEventListener('click', () => {
    cleanSel[i] = !cleanSel[i];
    store(CLEAN_SEL_KEY, cleanSel);
    render();
  });
}

function cleanMask() { return cleanSel.reduce((m, on, i) => m | (on ? 1 << i : 0), 0); }

function renderClean() {
  const online = !!st;
  const s = st?.s;
  const cleaning = s === 'CLEANING';
  const otherMotion = s === 'RUNNING';
  const mask = cleanMask();
  const outRpm = online ? st.max / 10 : null;
  $('cleanSpeed').textContent = online ? `${fmt(st.mmr / 10, 0)} rpm motor · ${fmt(outRpm)} rpm output` : 'Max speed';
  const period = outRpm ? 60 / outRpm : 1.73;

  for (let i = 0; i < 4; i++) {
    const tile = $(`ct${i}`);
    const spinning = cleaning && ((st.cl >> i) & 1);
    const picked = cleaning ? !!((st.cl >> i) & 1) : cleanSel[i];
    tile.setAttribute('aria-pressed', String(picked));
    tile.disabled = cleaning;
    tile.classList.toggle('spinning', !!spinning);
    tile.style.setProperty('--period', `${period.toFixed(2)}s`);
    $(`ctName${i}`).textContent = cal.name(i);
    $(`ctCheck${i}`).textContent = spinning ? 'Spinning' : picked ? 'Selected' : 'Not selected';
    const rev = online && (cleaning || st.cel > 0) && ((st.cl >> i) & 1) ? st.crev[i] : null;
    $(`ctRev${i}`).textContent = rev !== null ? `${fmt(rev, 1)} output rev${cleaning ? '' : ' last pass'}` : ' ';
  }

  const ready = $('cleanReady').checked;
  $('cleanAll').disabled = $('cleanNone').disabled = cleaning;
  let note = '';
  if (!online) note = 'Connect the Mega or start the simulator to clean.';
  else if (otherMotion) note = 'A dispense run is in progress. Stop it before cleaning.';
  else if (cleaning) note = 'Spinning until you press Stop (or the red button on the panel).';
  else if (!mask) note = 'Pick at least one dispenser.';
  else if (!ready) note = 'Tick the checkbox once the canister is off and a tray is in place.';
  else if (st.cel > 0) note = 'Still seeing powder come out? Start another pass.';
  $('cleanNote').textContent = note;

  const canStart = online && !busyState(s) && mask > 0 && ready;
  $('cleanStart').disabled = !canStart;
  $('cleanStart').textContent = online && st.cel > 0 && !cleaning ? 'Clean again' : 'Start cleaning';
  $('cleanStop').disabled = !cleaning;
  $('cleanTime').textContent = online ? mmss(st.cel) : '0:00';
  $('cleanTimeLabel').textContent = !online ? 'Not connected' : cleaning ? `Cleaning ${maskNames(st.cl)}` : st.cel > 0 ? 'Last pass' : 'Not running';
  $('cleanDot').hidden = !cleaning;
}

function renderCleanHistory() {
  const has = cleanHist.length > 0;
  $('histEmpty').hidden = has;
  $('histTable').hidden = !has;
  $('cleanClearHist').disabled = !has;
  $('histBody').innerHTML = cleanHist.map(h => `
    <tr>
      <td>${esc(new Date(h.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }))}</td>
      <td>${[0, 1, 2, 3].filter(i => (h.mask >> i) & 1).map(i => `<span class="sw" style="background:var(${COLOR_VARS[i]})"></span>${esc(cal.name(i))}`).join(' &nbsp;')}</td>
      <td class="num">${mmss(h.ms)}</td>
      <td class="num">${fmt(h.rev, 1)}</td>
      <td>${esc(h.by)}</td>
    </tr>`).join('');
}

function renderMotionBar() {
  const s = st?.s;
  const bar = $('motionBar');
  bar.hidden = !busyState(s);
  if (s === 'CLEANING') $('motionText').textContent = `Cleaning ${maskNames(st.cl)} · ${mmss(st.cel)}`;
  else if (s === 'RUNNING') $('motionText').textContent = `Dispense run · ${fmt(st.el / 1000, 0)} of ${st.d} s`;
}

/* ======================================================= 3D assembly */

let viewer = null;
let viewerKey = null;
const currentTab = () => document.querySelector('.tab[aria-current="page"]')?.dataset.tab || 'dispense';
const bits = mask => [0, 1, 2, 3].filter(i => (mask >> i) & 1);

async function initViewer() {
  try {
    const { AssemblyViewer } = await import('./viewer3d.js');
    const cs = getComputedStyle(document.documentElement);
    viewer = new AssemblyViewer($('v3d'), { colors: COLOR_VARS.map(v => cs.getPropertyValue(v).trim()), onPick: pickMotor });
    await viewer.load('assets/assembly.glb', p => { $('v3dBar').style.width = `${(p * 100).toFixed(0)}%`; });
    $('v3dLoading').hidden = true;
    window.lpbfViewer = viewer;   // handy from the browser console
    viewerKey = null;
    updateViewer();
  } catch (e) {
    $('v3dLoading').innerHTML = `<span>The 3D model could not load: ${esc(e.message || e)}</span>`;
    viewer = null;
  }
}

// which motors the view should show, given the tab and the board state
function viewerSelection() {
  const tab = currentTab();
  const s = st?.s;
  if (tab === 'clean') return s === 'CLEANING' ? bits(st.cl) : [0, 1, 2, 3].filter(i => cleanSel[i]);
  if (tab === 'dispense' && st) {
    if (s === 'SETUP') return [st.a];
    return [0, 1, 2, 3].filter(i => vals[i] > 0);
  }
  return [];
}

function updateViewer() {
  if (!viewer) return;
  const sel = viewerSelection();
  const s = st?.s;
  const spin = s === 'CLEANING' ? st.cl : s === 'RUNNING' ? st.rpm.reduce((m, r, i) => m | (r > 0 ? 1 << i : 0), 0) : 0;
  viewer.setSpinning(spin);
  const key = sel.join(',');
  if (key !== viewerKey) { viewerKey = key; viewer.focus(sel); }
  const turning = sel.filter(i => (spin >> i) & 1).length ? ' · turning' : '';
  $('v3dCaption').innerHTML = !sel.length ? 'Whole machine'
    : sel.length === 1 ? `<b>Motor ${sel[0] + 1} · ${MOTORS[sel[0]].drv} driver</b> · ${esc(cal.name(sel[0]))}${turning}`
    : `<b>${sel.map(i => `M${i + 1}`).join(', ')}</b> highlighted${turning}`;
}

// clicking a motor in the 3D view selects it on the current tab
function pickMotor(i) {
  const tab = currentTab();
  const s = st?.s;
  if (tab === 'clean' && s !== 'CLEANING') {
    cleanSel[i] = !cleanSel[i];
    store(CLEAN_SEL_KEY, cleanSel);
    render();
  } else if (tab === 'dispense' && st && !busyState(s)) {
    send(`SEL ${i + 1}`);
  } else if (viewer) {
    viewerKey = null;
    viewer.focus([i]);
  }
}

/* ======================================================= tabs */

const TABS = ['dispense', 'calibrate', 'clean', 'device', 'reference'];
let docsView = null;
function showTab() {
  let tab = location.hash.replace('#', '');
  if (!TABS.includes(tab)) tab = load('lpbf.tab', 'dispense');
  if (!TABS.includes(tab)) tab = 'dispense';
  $('app').dataset.tab = tab;              // the Reference tab uses the full width
  if (tab === 'reference') {
    if (!docsView) docsView = new DocsView();
    docsView.show();
  }
  document.querySelectorAll('.view').forEach(v => { v.hidden = v.dataset.view !== tab; });
  document.querySelectorAll('.tab').forEach(a => {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  store('lpbf.tab', tab);
  updateViewer();
}

function renderTrial() {
  const form = $('trialForm');
  const empty = $('trialEmpty');
  const show = st?.s === 'DONE' && st.rev.some(r => r > 0.01);
  if (!show) {
    form.hidden = true; empty.hidden = false; trialKey = null;
    empty.textContent = 'No finished run to record yet. Run a mix on the Dispense tab, then come back here to enter the weighed masses.';
    return;
  }
  const key = `${st.el}|${st.rev.join(',')}`;
  const saved = trialSavedKey === key;
  form.hidden = saved;
  empty.hidden = !saved;
  if (saved) empty.textContent = 'This run is recorded. Run another mix to add more points.';
  if (trialKey === key) return;
  trialKey = key;
  $('trialMsg').textContent = '';
  $('trialRows').innerHTML = st.rev.map((r, i) => r > 0.01 ? `
    <label class="field">
      <span><span class="sw" style="background:var(${COLOR_VARS[i]})"></span>${esc(cal.name(i))}</span>
      <span class="input-unit"><input type="number" min="0" step="0.001" id="trial${i}" inputmode="decimal" placeholder="weighed mass"><em>g</em></span>
      <small class="note">${fmt(r, 3)} rev at ${fmt(st.rpm[i] / 10)} rpm</small>
    </label>` : '').join('');
}

function renderCalibration() {
  $('calGrid').innerHTML = [0, 1, 2, 3].map(i => {
    const pts = cal.points(i);
    let chart = '<p class="note">No trials yet. Run this canister, weigh the output and record it above.</p>';
    if (pts.length) {
      const W = 260, H = 70, P = 6;
      const maxR = Math.max(...pts.map(p => p.rpm)) * 1.15 || 1;
      const maxG = Math.max(...pts.map(p => p.gpr)) * 1.25 || 1;
      const x = r => P + (W - 2 * P) * r / maxR, y = g => H - P - (H - 2 * P) * g / maxG;
      const line = pts.map(p => `${x(p.rpm).toFixed(1)},${y(p.gpr).toFixed(1)}`).join(' ');
      chart = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Grams per revolution against rpm">
        <line x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}" stroke="var(--line-strong)"/>
        <polyline points="${line}" fill="none" stroke="var(--c)" stroke-width="2"/>
        ${pts.map(p => `<circle cx="${x(p.rpm).toFixed(1)}" cy="${y(p.gpr).toFixed(1)}" r="3.5" fill="var(--surface)" stroke="var(--c)" stroke-width="2"/>`).join('')}
        <text x="${W - P}" y="${H - P - 4}" text-anchor="end" font-size="9" fill="var(--muted)">${fmt(maxR / 1.15)} rpm</text>
        <text x="${P + 2}" y="${P + 8}" font-size="9" fill="var(--muted)">${pts.length > 1 ? 'g/rev vs rpm' : 'single point'}</text>
      </svg>
      <table><thead><tr><th class="num">rpm</th><th class="num">rev</th><th class="num">g</th><th class="num">g/rev</th><th></th></tr></thead><tbody>
        ${pts.map(p => `<tr><td class="num">${fmt(p.rpm)}</td><td class="num">${fmt(p.revs, 2)}</td><td class="num">${fmt(p.grams, 3)}</td><td class="num">${p.gpr.toFixed(4)}</td>
          <td><button class="x" data-i="${i}" data-at="${esc(p.at)}" aria-label="Delete trial at ${fmt(p.rpm)} rpm">×</button></td></tr>`).join('')}
      </tbody></table>`;
    }
    return `<div class="cal" data-i="${i}"><div class="cal-head"><b>${esc(cal.name(i))}</b><span class="note">${pts.length} trial${pts.length === 1 ? '' : 's'}</span></div>${chart}</div>`;
  }).join('');
}

/* ======================================================= log */

function log(kind, text) {
  const list = $('logList');
  const li = document.createElement('li');
  li.className = kind;
  const t = new Date().toLocaleTimeString([], { hour12: false });
  li.innerHTML = `<span class="t">${t}</span>${kind === 'tx' ? '→ ' : ''}${esc(text)}`;
  list.appendChild(li);
  while (list.children.length > 300) list.firstChild.remove();
  list.scrollTop = list.scrollHeight;
}

/* ======================================================= wiring */

function init() {
  buildSteps();
  buildMotors();
  buildInv();
  buildCleanTiles();
  renderCalibration();
  renderCleanHistory();
  showTab();
  window.addEventListener('hashchange', showTab);
  render();

  initViewer();
  $('v3dOverview').addEventListener('click', () => { if (viewer) { viewerKey = null; viewer.focus([]); viewerKey = viewerSelection().join(','); } });
  $('v3dSwap').addEventListener('click', () => {
    const a = Number($('v3dA').value), b = Number($('v3dB').value);
    if (viewer && a !== b) { viewer.swap(a, b); log('sys', `3D view: swapped M${a + 1} and M${b + 1}`); }
  });
  $('v3dResetOrder').addEventListener('click', () => viewer?.resetOrder());

  $('cleanStart').addEventListener('click', () => { const m = cleanMask(); if (m) send(`CLEAN ${m}`); });
  $('cleanStop').addEventListener('click', () => send('STOP'));
  $('motionStop').addEventListener('click', () => send('STOP'));
  $('cleanReady').addEventListener('change', render);
  $('cleanAll').addEventListener('click', () => { cleanSel = [true, true, true, true]; store(CLEAN_SEL_KEY, cleanSel); render(); });
  $('cleanNone').addEventListener('click', () => { cleanSel = [false, false, false, false]; store(CLEAN_SEL_KEY, cleanSel); render(); });
  $('cleanClearHist').addEventListener('click', () => { cleanHist = []; store(CLEAN_HIST_KEY, cleanHist); renderCleanHistory(); });

  $('btnConnect').addEventListener('click', () => connectSerial());

  // reconnect on its own to a Mega this browser was already allowed to use: at launch, and when it's plugged in
  if (SerialLink.supported()) {
    const autoConnect = async () => {
      if (link) return;
      const ports = await SerialLink.knownPorts();
      if (ports.length === 1) { log('sys', 'Reconnecting to the Mega used last time…'); connectSerial(ports[0]); }
    };
    autoConnect();
    navigator.serial.addEventListener('connect', () => setTimeout(autoConnect, 500));
  }
  $('btnSim').addEventListener('click', connectSim);
  $('btnDisconnect').addEventListener('click', disconnect);
  $('btnNext').addEventListener('click', () => send('NEXT'));
  $('btnGo').addEventListener('click', () => send('GO'));
  $('btnStop').addEventListener('click', () => send('STOP'));
  $('btnReset').addEventListener('click', () => send('RESET'));
  $('simRed').addEventListener('click', () => link?.press?.('next'));
  $('simGreen').addEventListener('click', () => link?.press?.('go'));

  $('inDur').addEventListener('change', e => {
    const v = Math.round(Number(e.target.value));
    if (v >= 1 && v <= 3600) send(`DUR ${v}`); else render();
  });
  $('inTop').addEventListener('change', e => {
    const v = Math.round(Number(e.target.value) * 10);
    if (v >= 1 && v <= 3000) send(`TOP ${v}`); else render();
  });
  $('inMs').addEventListener('change', e => send(`MS ${e.target.value}`));
  $('inGear').addEventListener('change', e => {
    const v = Math.round(Number(e.target.value) * 100);
    if (v >= 100 && v <= 10000) send(`GEAR ${v}`); else render();
  });

  $('trialForm').addEventListener('submit', e => {
    e.preventDefault();
    if (!st) return;
    let n = 0;
    for (let i = 0; i < 4; i++) {
      const input = $(`trial${i}`);
      const g = input ? Number(input.value) : 0;
      if (input && input.value !== '' && g > 0 && st.rev[i] > 0.01) {
        cal.addPoint(i, { rpm: st.rpm[i] / 10, revs: st.rev[i], grams: g, secs: st.el / 1000 });
        n++;
      }
    }
    if (!n) { $('trialMsg').textContent = 'Enter at least one weighed mass first.'; return; }
    trialSavedKey = trialKey;
    log('sys', `Saved ${n} calibration point${n === 1 ? '' : 's'}.`);
    renderCalibration();
    render();
  });

  $('calGrid').addEventListener('click', e => {
    const b = e.target.closest('button.x');
    if (!b) return;
    cal.removePoint(Number(b.dataset.i), b.dataset.at);
    renderCalibration();
    render();
  });

  $('btnExport').addEventListener('click', () => {
    const blob = new Blob([cal.csv()], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `lpbf-calibration-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  $('cmdForm').addEventListener('submit', e => {
    e.preventDefault();
    const v = $('cmdIn').value.trim();
    if (!v) return;
    send(v);
    $('cmdIn').value = '';
  });
  $('btnClearLog').addEventListener('click', () => { $('logList').innerHTML = ''; });

  // heartbeat: the board stops cleaning on its own if this page goes quiet for 5 s
  setInterval(() => { if (link && hello) link.send('KA'); }, 1000);
  window.addEventListener('beforeunload', () => { if (link && busyState(st?.s)) link.send('STOP'); });

  // watchdog: flag a silent board
  setInterval(() => {
    if (!link || !hello) return;
    const silent = performance.now() - lastStatusAt > 2500;
    const kind = link.kind === 'sim' ? 'sim' : 'on';
    $('connPill').dataset.state = silent ? 'wait' : kind;
  }, 1000);

  if (!SerialLink.supported()) log('sys', 'Web Serial is not available in this browser. The simulator still works.');
  else log('sys', 'Ready. Connect the Mega or start the simulator.');
}

init();
