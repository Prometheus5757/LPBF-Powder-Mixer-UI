// 3D view of the dispenser assembly (ui/assets/assembly.glb, converted from FullDesign.step by tools/convert.html).
// focus([]) shows the whole machine, focus([i]) flies to one motor, focus([i, j, …]) frames several and
// boxes them. Motor numbering follows the RAMPS drivers: 1 = X, 2 = Y, 3 = Z, 4 = E0.
//
// Performance: the camera is not user-controlled; it only moves when the selection changes. Frames are
// drawn only while something changes (a camera move, a hologram flash, a turning motor's pulse), and
// every static part is merged into one mesh per material so a frame is a few dozen draw calls.
//
// Hologram: the rest of the machine turns see-through briefly (about a second) when several motors are
// selected, or when the one selected motor would be hidden behind other parts. Otherwise it stays solid.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const MOTOR_NAME = /^17HS15-1684S-PG5/;
const ORDER_KEY = 'lpbf.viewer.motorOrder';
const DRIVERS = ['X', 'Y', 'Z', 'E0'];
const MOVE_MS = 900;
const HOLO_IN_MS = 500, HOLO_HOLD_MS = 1000, HOLO_OUT_MS = 700;   // ease in, hold ~1 s after the camera arrives, ease out
const HOLO_OPACITY = 0.3;
const PULSE_FPS = 30;
const VISIBLE_ENOUGH = 0.55;      // share of a motor's pixels that must be unblocked to count as "in view"
const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class AssemblyViewer {
  /**
   * @param {HTMLElement} host  element the canvas and callouts go into
   * @param {{colors: string[], onPick?: (motor: number) => void}} opts
   */
  constructor(host, opts) {
    this.host = host;
    this.colors = opts.colors.map(c => new THREE.Color(c));
    this.cssColors = opts.colors;
    this.onPick = opts.onPick || (() => {});
    this.selected = [];
    this.spinning = 0;
    this.motors = [];          // [{ group, box, center, mats, helper, label, index }]
    this.staticMeshes = [];    // merged non-motor geometry
    this.ghostMats = [];
    this.move = null;          // camera animation
    this.holo = null;          // hologram flash timeline
    this.holoLevel = 0;        // 0 solid … 1 fully see-through
    this.dirty = true;
    this.lastPulse = 0;
    this.ready = false;
    this.target = new THREE.Vector3();

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    host.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 1, 100000);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(1, 2, 1.5);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.6);
    fill.position.set(-1.5, 0.5, -1);
    this.scene.add(fill);

    this.labels = document.createElement('div');
    this.labels.className = 'v3d-labels';
    host.appendChild(this.labels);

    new ResizeObserver(() => { this.resize(); this.dirty = true; }).observe(host);
    this.resize();
    this.pickSetup();
    const loop = t => { this.frame(t); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  async load(url, onProgress) {
    const gltf = await new GLTFLoader().loadAsync(url, e => e.total && onProgress?.(e.loaded / e.total));
    const model = gltf.scene;
    this.model = model;

    // stand it upright (Fusion STEP exports are Z-up, three.js is Y-up) and centre it on the floor
    const size0 = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
    if (size0.z > size0.y * 1.05) model.rotation.x = -Math.PI / 2;
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const c = box.getCenter(new THREE.Vector3());
    model.position.sub(new THREE.Vector3(c.x, box.min.y, c.z));
    model.updateMatrixWorld(true);
    this.scene.add(model);
    this.bounds = new THREE.Box3().setFromObject(model);
    this.radius = this.bounds.getSize(new THREE.Vector3()).length() / 2;
    this.camera.near = this.radius / 200;
    this.camera.far = this.radius * 40;
    this.camera.updateProjectionMatrix();

    // the four motors stay separate so they can be tinted, boxed and picked
    const found = [];
    model.traverse(o => {
      if ((o.isGroup || o.type === 'Object3D') && MOTOR_NAME.test(o.name) && !found.some(f => isAncestor(f, o))) found.push(o);
    });
    const infos = found.slice(0, 4).map(group => {
      const b = new THREE.Box3().setFromObject(group);
      return { group, box: b, center: b.getCenter(new THREE.Vector3()) };
    });
    this.motors = this.loadOrder(infos).map((info, i) => this.prepareMotor(info, i));

    this.mergeStatic(model);
    this.warmShaders();
    this.ready = true;
    this.focus(this.selected, true);
  }

  // bake every non-motor mesh into world space and merge by material: thousands of draw calls become dozens
  mergeStatic(model) {
    const motorGroups = this.motors.map(m => m.group);
    const inMotor = o => motorGroups.some(g => g === o || isAncestor(g, o));
    const byMat = new Map();
    const drop = [];
    model.traverse(o => {
      if (!o.isMesh || inMotor(o)) return;
      const g = o.geometry.clone();
      for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
      if (!g.attributes.normal) g.computeVertexNormals();
      if (!g.index) g.setIndex([...Array(g.attributes.position.count).keys()]);
      g.applyMatrix4(o.matrixWorld);
      if (!byMat.has(o.material)) byMat.set(o.material, []);
      byMat.get(o.material).push(g);
      drop.push(o);
    });
    drop.forEach(o => { o.parent.remove(o); o.geometry.dispose(); });
    for (const [mat, geos] of byMat) {
      const merged = mergeGeometries(geos, false);
      geos.forEach(g => g.dispose());
      if (!merged) continue;
      const mesh = new THREE.Mesh(merged, mat);
      mesh.matrixAutoUpdate = false;
      this.scene.add(mesh);
      this.staticMeshes.push(mesh);
      this.ghostMats.push(mat);
    }
    model.traverse(o => { if (o !== model) o.matrixAutoUpdate = false; });
  }

  // Every material stays in transparent mode for good, at opacity 1 while solid. The hologram then only
  // changes opacity and depthWrite, which never needs a shader switch (switching mid-fade left stale,
  // solid-looking shaders). Compile once up front so the first frame doesn't stutter.
  warmShaders() {
    [...this.ghostMats, ...this.motors.flatMap(m => m.mats)].forEach(mt => {
      mt.transparent = true;
      mt.opacity = 1;
      mt.depthWrite = true;
      mt.needsUpdate = true;
    });
    this.renderer.compile(this.scene, this.camera);
  }

  // default numbering from positions: motors 1 & 2 share the front side (left, right), 3 across from 1, 4 across from 2
  defaultOrder(infos) {
    if (infos.length < 4) return infos;
    const cs = infos.map(i => i.center);
    const spread = axis => { const v = cs.map(c => c[axis]).sort((a, b) => a - b); return v[2] - v[1]; };
    const depth = spread('x') > spread('z') ? 'x' : 'z';
    const side = depth === 'x' ? 'z' : 'x';
    const sorted = [...infos].sort((a, b) => a.center[depth] - b.center[depth]);
    const front = sorted.slice(2), back = sorted.slice(0, 2);
    const across = (m, pool) => pool.reduce((best, p) => Math.abs(p.center[side] - m.center[side]) < Math.abs(best.center[side] - m.center[side]) ? p : best);
    front.sort((a, b) => a.center[side] - b.center[side]);
    const m1 = front[0], m2 = front[1];
    const m3 = across(m1, back), m4 = back.find(b => b !== m3);
    return [m1, m2, m3, m4];
  }

  loadOrder(infos) {
    const order = this.defaultOrder(infos);
    try {
      const saved = JSON.parse(localStorage.getItem(ORDER_KEY) || 'null');
      if (Array.isArray(saved) && saved.length === order.length) {
        const byKey = new Map(infos.map(i => [posKey(i.center), i]));
        const mapped = saved.map(k => byKey.get(k));
        if (mapped.every(Boolean)) return mapped;
      }
    } catch { /* ignore */ }
    return order;
  }

  /** swap which physical motor is called motor a and motor b; remembered in this browser */
  swap(a, b) {
    [this.motors[a], this.motors[b]] = [this.motors[b], this.motors[a]];
    this.motors.forEach((m, i) => this.restyleMotor(m, i));
    try { localStorage.setItem(ORDER_KEY, JSON.stringify(this.motors.map(m => posKey(m.center)))); } catch { /* ignore */ }
    this.focus(this.selected);
  }

  resetOrder() {
    try { localStorage.removeItem(ORDER_KEY); } catch { /* ignore */ }
    const order = this.defaultOrder(this.motors.map(m => ({ group: m.group, box: m.box, center: m.center })));
    this.motors = order.map(info => this.motors.find(m => m.group === info.group));
    this.motors.forEach((m, i) => this.restyleMotor(m, i));
    this.focus(this.selected);
  }

  prepareMotor(info, i) {
    const mats = [];
    const meshes = [];
    info.group.traverse(o => {
      if (!o.isMesh) return;
      o.material = o.material.clone();     // motors get their own materials so they can glow
      o.renderOrder = 1;                   // drawn after the machine, so they read clearly through the hologram
      mats.push(o.material);
      meshes.push(o);
    });
    const pad = info.box.getSize(new THREE.Vector3()).multiplyScalar(0.08);
    const b = info.box.clone().expandByVector(pad);
    const helper = new THREE.Box3Helper(b, this.colors[i]);
    helper.material.depthTest = false;     // the box stays visible through solid parts
    helper.material.transparent = true;
    helper.renderOrder = 10;
    helper.visible = false;
    this.scene.add(helper);
    const label = document.createElement('div');
    label.className = 'v3d-callout';
    label.hidden = true;
    this.labels.appendChild(label);
    const m = { ...info, mats, meshes, helper, label, top: new THREE.Vector3(info.center.x, b.max.y, info.center.z) };
    meshes.forEach(o => { o.userData.motorRef = m; });
    this.restyleMotor(m, i);
    return m;
  }

  restyleMotor(m, i) {
    m.index = i;
    m.helper.material.color.copy(this.colors[i]);
    m.label.style.setProperty('--c', this.cssColors[i]);
    m.label.innerHTML = `<b>M${i + 1}</b> · ${DRIVERS[i]}`;
    this.dirty = true;
  }

  /** camera placement for a selection: { target, position } */
  shot(sel) {
    let target, dir, dist;
    if (!sel.length) {
      target = this.bounds.getCenter(new THREE.Vector3());
      dir = new THREE.Vector3(1, 0.75, 1.25).normalize();
      dist = this.fitDistance(this.radius);
    } else {
      const box = new THREE.Box3();
      sel.forEach(i => box.union(this.motors[i].box));
      target = box.getCenter(new THREE.Vector3());
      const outward = target.clone().sub(this.bounds.getCenter(new THREE.Vector3()));
      outward.y = 0;
      if (outward.lengthSq() < 1) outward.set(0, 0, 1);
      outward.normalize();
      dir = outward.add(new THREE.Vector3(0, 0.55, 0)).normalize();
      if (sel.length > 1) {                // pull back and look from higher so every pick is in frame
        dir = new THREE.Vector3(dir.x * 0.6, 1.0, dir.z * 0.6 + 0.8).normalize();
        dist = this.fitDistance(box.getSize(new THREE.Vector3()).length() / 2 + this.radius * 0.18);
      } else {
        dist = this.fitDistance(box.getSize(new THREE.Vector3()).length() / 2) * 2.4;
      }
    }
    return { target, position: target.clone().add(dir.multiplyScalar(dist)) };
  }

  /** motors: zero-based indices to highlight */
  focus(motors, instant = false) {
    this.selected = [...new Set(motors)].filter(i => i >= 0 && i < 4).sort();
    if (!this.ready) return;
    const sel = this.selected;
    this.motors.forEach((m, i) => {
      const on = sel.includes(i);
      m.helper.visible = on && sel.length > 1;
      m.label.hidden = !on;
      if (on) m.mats.forEach(mt => { mt.opacity = 1; mt.depthWrite = true; });   // picked motors are always solid
    });
    this.restoreTints();

    const { target, position } = this.shot(sel);

    // flash the hologram for several motors, or for one that other parts would hide
    const flash = sel.length > 1 || (sel.length === 1 && this.visibleShare(sel[0], position, target) < VISIBLE_ENOUGH);
    if (flash) this.holo = { t0: performance.now(), arrive: instant ? 0 : MOVE_MS };
    else if (this.holo) this.holo = { ...this.holo, t0: performance.now() - (this.holo.arrive + HOLO_IN_MS + HOLO_HOLD_MS), fadeFrom: this.holoLevel };

    if (instant) {
      this.camera.position.copy(position);
      this.target.copy(target);
      this.camera.lookAt(this.target);
      this.move = null;
    } else {
      this.move = { t0: performance.now(), fromPos: this.camera.position.clone(), fromTgt: this.target.clone(), toPos: position, toTgt: target };
    }
    this.dirty = true;
  }

  /**
   * Share (0…1) of motor i's pixels that are not covered by other parts when seen from a camera at `pos`
   * looking at `tgt`. Two tiny offscreen renders: motor alone, then motor with everything else in front.
   */
  visibleShare(i, pos, tgt) {
    const W = 96, H = 72;
    if (!this.occ) {
      this.occ = {
        rt: new THREE.WebGLRenderTarget(W, H),
        cam: new THREE.PerspectiveCamera(),
        white: new THREE.MeshBasicMaterial({ color: 0xffffff }),
        black: new THREE.MeshBasicMaterial({ color: 0x000000 }),
        buf: new Uint8Array(W * H * 4)
      };
    }
    const { rt, cam, white, black, buf } = this.occ;
    cam.copy(this.camera);
    cam.aspect = this.camera.aspect;
    cam.position.copy(pos);
    cam.lookAt(tgt);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();

    const saved = [];
    const swapMat = (mesh, mat) => { saved.push([mesh, mesh.material]); mesh.material = mat; };
    const motor = this.motors[i];
    motor.meshes.forEach(o => swapMat(o, white));
    this.motors.forEach((m, k) => { if (k !== i) m.meshes.forEach(o => swapMat(o, black)); });
    this.staticMeshes.forEach(o => swapMat(o, black));
    const helpers = this.motors.map(m => m.helper.visible);
    this.motors.forEach(m => { m.helper.visible = false; });
    const prevClear = this.renderer.getClearAlpha();
    const prevTarget = this.renderer.getRenderTarget();
    const count = () => {
      this.renderer.setRenderTarget(rt);
      this.renderer.setClearColor(0x000000, 1);
      this.renderer.clear();
      this.renderer.render(this.scene, cam);
      this.renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
      let n = 0;
      for (let p = 0; p < buf.length; p += 4) if (buf[p] > 127) n++;
      return n;
    };
    const blocked = count();
    this.staticMeshes.forEach(o => { o.visible = false; });
    this.motors.forEach((m, k) => { if (k !== i) m.meshes.forEach(o => { o.visible = false; }); });
    const alone = count();
    this.staticMeshes.forEach(o => { o.visible = true; });
    this.motors.forEach(m => m.meshes.forEach(o => { o.visible = true; }));

    saved.reverse().forEach(([mesh, mat]) => { mesh.material = mat; });
    this.motors.forEach((m, k) => { m.helper.visible = helpers[k]; });
    this.renderer.setRenderTarget(prevTarget);
    this.renderer.setClearColor(0x000000, prevClear);
    return alone ? blocked / alone : 0;
  }

  /** bitmask of motors currently turning, so their glow pulses */
  setSpinning(mask) {
    if (mask === this.spinning) return;
    this.spinning = mask;
    this.restoreTints();
  }

  // steady colours: selected motors glow in their colour, the rest are plain
  restoreTints() {
    this.motors.forEach((m, i) => {
      const on = this.selected.includes(i);
      m.mats.forEach(mt => { mt.emissive.copy(on ? this.colors[i] : new THREE.Color(0)); mt.emissiveIntensity = on ? 0.45 : 0; });
    });
    this.dirty = true;
  }

  fitDistance(r) {
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const fovH = 2 * Math.atan(Math.tan(fov / 2) * this.camera.aspect);
    return r / Math.sin(Math.min(fov, fovH) / 2);
  }

  resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // click a motor to select it; the pointer changes over motors so it reads as clickable
  pickSetup() {
    const ray = new THREE.Raycaster();
    const el = this.renderer.domElement;
    const hitMotor = e => {
      if (!this.ready) return null;
      const r = el.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
      return ray.intersectObjects(this.motors.flatMap(m => m.meshes), false)[0]?.object.userData.motorRef || null;
    };
    el.addEventListener('click', e => { const m = hitMotor(e); if (m) this.onPick(m.index); });
    let pending = false;
    el.addEventListener('pointermove', e => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => { pending = false; el.style.cursor = hitMotor(e) ? 'pointer' : 'default'; });
    });
  }

  // hologram level over time: fade in, hold until ~1 s after the camera arrives, fade back to solid
  holoAt(t) {
    const h = this.holo;
    if (!h) return 0;
    const e = Math.max(0, t - h.t0);         // rAF time can be a hair earlier than focus() time
    const holdEnd = Math.max(h.arrive, HOLO_IN_MS) + HOLO_HOLD_MS;
    if (h.fadeFrom === undefined) {
      if (e < HOLO_IN_MS) return ease(e / HOLO_IN_MS);
      if (e < holdEnd) return 1;
    }
    const out = (e - holdEnd) / HOLO_OUT_MS;
    if (out >= 1) { this.holo = null; return 0; }
    return (h.fadeFrom ?? 1) * (1 - ease(Math.max(0, out)));
  }

  applyHolo(level) {
    if (level === this.holoLevel && level !== 0) return;
    const was = this.holoLevel;
    this.holoLevel = level;
    const see = level > 0.001;
    const opacity = 1 - (1 - HOLO_OPACITY) * level;
    const set = mt => {
      mt.depthWrite = !see;                  // see-through parts must not hide what's behind them
      mt.opacity = see ? opacity : 1;
    };
    this.ghostMats.forEach(set);
    this.motors.forEach((m, i) => { if (!this.selected.includes(i)) m.mats.forEach(set); });
    if (was !== level) this.dirty = true;
  }

  frame(t) {
    if (!this.ready) { if (this.dirty) { this.renderer.render(this.scene, this.camera); this.dirty = false; } return; }
    let changed = this.dirty;
    if (this.move) {
      const k = Math.min(1, (t - this.move.t0) / MOVE_MS);
      const e = ease(k);
      this.camera.position.lerpVectors(this.move.fromPos, this.move.toPos, e);
      this.target.lerpVectors(this.move.fromTgt, this.move.toTgt, e);
      this.camera.lookAt(this.target);
      if (k >= 1) this.move = null;
      changed = true;
    }
    if (this.holo || this.holoLevel) { this.applyHolo(this.holoAt(t)); changed = true; }
    if (this.spinning && t - this.lastPulse > 1000 / PULSE_FPS) {
      this.lastPulse = t;
      const pulse = 0.25 + 0.45 * (0.5 + 0.5 * Math.sin(t / 160));
      this.motors.forEach((m, i) => {
        if (!((this.spinning >> i) & 1)) return;
        m.mats.forEach(mt => { mt.emissive.copy(this.colors[i]); mt.emissiveIntensity = pulse; });
      });
      changed = true;
    }
    if (!changed) return;
    this.dirty = false;
    this.renderer.render(this.scene, this.camera);
    this.placeLabels();
  }

  placeLabels() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    const v = new THREE.Vector3();
    this.motors.forEach(m => {
      if (m.label.hidden) return;
      v.copy(m.top).project(this.camera);
      m.label.style.transform = `translate(${((v.x + 1) / 2 * w).toFixed(1)}px, ${((1 - v.y) / 2 * h).toFixed(1)}px) translate(-50%, calc(-100% - 8px))`;
      m.label.style.opacity = v.z > 1 ? 0 : 1;
    });
  }
}

function isAncestor(a, b) { for (let p = b.parent; p; p = p.parent) if (p === a) return true; return false; }
function posKey(v) { return [v.x, v.y, v.z].map(n => Math.round(n)).join(','); }
