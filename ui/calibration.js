// Calibration curve per canister, kept in this browser (localStorage).
// Each trial records the output-shaft speed it ran at, the revolutions the firmware counted
// and the mass weighed afterwards. Grams per revolution is interpolated against rpm, so the
// curve can bend if a dispenser's output per turn changes with speed.

const KEY = 'lpbf.calibration.v1';
const DEFAULT_NAMES = ['Canister 1', 'Canister 2', 'Canister 3', 'Canister 4'];

function blank() {
  return { motors: DEFAULT_NAMES.map(name => ({ name, points: [] })) };
}

export class Calibration {
  constructor() {
    try { this.data = JSON.parse(localStorage.getItem(KEY) || 'null') || blank(); }
    catch { this.data = blank(); }
    if (!Array.isArray(this.data.motors) || this.data.motors.length !== 4) this.data = blank();
  }

  save() { try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch { /* storage unavailable */ } }

  name(i) { return this.data.motors[i].name || DEFAULT_NAMES[i]; }
  setName(i, name) { this.data.motors[i].name = name.trim() || DEFAULT_NAMES[i]; this.save(); }

  points(i) { return [...this.data.motors[i].points].sort((a, b) => a.rpm - b.rpm); }

  addPoint(i, p) {
    this.data.motors[i].points.push({ ...p, gpr: p.grams / p.revs, at: new Date().toISOString() });
    this.save();
  }

  removePoint(i, at) {
    this.data.motors[i].points = this.data.motors[i].points.filter(p => p.at !== at);
    this.save();
  }

  /** grams per output revolution at a given rpm, or null if the canister has no trials */
  gramsPerRev(i, rpm) {
    const pts = this.points(i);
    if (!pts.length) return null;
    if (pts.length === 1 || rpm <= pts[0].rpm) return pts[0].gpr;
    const last = pts[pts.length - 1];
    if (rpm >= last.rpm) return last.gpr;
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1], b = pts[k];
      if (rpm <= b.rpm) {
        if (b.rpm === a.rpm) return (a.gpr + b.gpr) / 2;
        const f = (rpm - a.rpm) / (b.rpm - a.rpm);
        return a.gpr + f * (b.gpr - a.gpr);
      }
    }
    return last.gpr;
  }

  csv() {
    const rows = [['canister', 'motor', 'rpm', 'seconds', 'revolutions', 'grams', 'grams_per_rev', 'recorded_at']];
    this.data.motors.forEach((m, i) => m.points.forEach(p =>
      rows.push([m.name, i + 1, p.rpm, p.secs, p.revs, p.grams, p.gpr.toFixed(5), p.at])));
    return rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  }
}
