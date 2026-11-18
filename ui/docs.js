// Reference tab: the project's own documents, read in place from the project folder
// (start-ui.bat serves the whole folder, so "../file" is the original, never a copy).

import { Marked } from './vendor/marked/marked.esm.js';

const DOCS = [
  {
    id: 'wiring', kind: 'Interactive', file: '../panel_wiring_diagram.html',
    title: 'Panel wiring diagram',
    blurb: 'Top-down render of the panel: RAMPS headers, breadboard, pots, buttons, LCD and motor plugs. Hover a wire to trace it.'
  },
  {
    id: 'config', kind: 'Markdown', file: '../ramps_1_4_complete_wiring_configuration_reference.md',
    title: 'RAMPS 1.4 wiring and configuration',
    blurb: 'Driver calibration, AUX-2 inputs, verification sketch and the pre-power-on checklist.',
    note: 'The AUX-2 map in section 2 pairs some pins differently from the RAMPS silkscreen (A11 next to D42, A12 next to D44). The panel wiring diagram follows the silkscreen: top row GND, A9, D40, D42, A11; bottom row 5V, A5, A10, D44, A12.'
  },
  {
    id: 'lcd', kind: 'Markdown', file: '../ramps_1_4_i2c_lcd_wiring_guide.md',
    title: 'I²C LCD wiring guide',
    blurb: '16×2 LCD on the RAMPS I²C header, plus the 12 V / 24 V regulator caution.'
  },
  {
    id: 'power', kind: 'Markdown', file: '../power_supply_and_ramps14_safety_record.md',
    title: 'Power supply and safety record',
    blurb: 'Mean Well LRS-350 mains wiring, enclosure covers, and feeding 12 V to the RAMPS inputs.'
  },
  {
    id: 'dossier', kind: 'PDF', file: '../RAMPS_dossier.pdf',
    title: 'RAMPS 1.4 dossier',
    blurb: 'Reference PDF for the RAMPS 1.4 board.'
  },
  {
    id: 'software', kind: 'Markdown', file: '../README.md',
    title: 'Software guide',
    blurb: 'How to run the UI, upload the firmware, clean, calibrate and use the 3D view, plus the serial protocol.'
  }
];

const KEY = 'lpbf.doc';
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// the docs use a little LaTeX for values like $V_{\text{ref}}$ and $10\text{ k}\Omega$; render that subset as text
function tex(src) {
  return esc(src)
    .replace(/\\text\{([^}]*)\}/g, '$1')
    .replace(/\\(approx)/g, '≈').replace(/\\times/g, '×').replace(/\\Omega/g, 'Ω').replace(/\\mu/g, 'µ')
    .replace(/\\pm/g, '±').replace(/\\leq?/g, '≤').replace(/\\geq?/g, '≥').replace(/\\cdot/g, '·').replace(/\\degree/g, '°')
    .replace(/\\[,;:! ]/g, ' ')
    .replace(/_\{([^}]*)\}/g, '<sub>$1</sub>').replace(/\^\{([^}]*)\}/g, '<sup>$1</sup>')
    .replace(/_([A-Za-z0-9])/g, '<sub>$1</sub>').replace(/\^([A-Za-z0-9])/g, '<sup>$1</sup>')
    .replace(/\s+/g, ' ').trim();
}

const md = new Marked({ gfm: true });
md.use({
  extensions: [{
    name: 'math', level: 'inline',
    start(src) { const m = src.match(/(?<!\\)\$/); return m ? m.index : undefined; },
    tokenizer(src) {
      const m = /^\$([^$\n]+?)\$/.exec(src);
      if (m) return { type: 'math', raw: m[0], text: m[1] };
      return undefined;
    },
    renderer(t) { return `<span class="math">${tex(t.text)}</span>`; }
  }]
});

export class DocsView {
  constructor() {
    this.list = document.getElementById('refList');
    this.body = document.getElementById('refBody');
    this.cache = new Map();
    let saved = null;
    try { saved = localStorage.getItem(KEY); } catch { /* ignore */ }
    this.current = DOCS.some(d => d.id === saved) ? saved : DOCS[0].id;
    this.list.innerHTML = DOCS.map(d => `
      <li><button class="ref-item" data-id="${d.id}" aria-current="false">
        <span class="ref-item-kind" data-kind="${d.kind}">${d.kind}</span>
        <b>${esc(d.title)}</b>
        <small>${esc(d.blurb)}</small>
      </button></li>`).join('');
    this.list.addEventListener('click', e => {
      const b = e.target.closest('.ref-item');
      if (b) this.open(b.dataset.id);
    });
    window.addEventListener('resize', () => this.fitFrame());
    this.loaded = false;
  }

  /** called when the Reference tab is shown; loads the remembered document the first time */
  show() {
    if (!this.loaded) { this.loaded = true; this.open(this.current); }
    else this.fitFrame();
  }

  async open(id) {
    const d = DOCS.find(x => x.id === id) || DOCS[0];
    this.current = d.id;
    try { localStorage.setItem(KEY, d.id); } catch { /* ignore */ }
    this.list.querySelectorAll('.ref-item').forEach(b => b.setAttribute('aria-current', String(b.dataset.id === d.id)));
    document.getElementById('refKind').textContent = d.kind;
    document.getElementById('refKind').dataset.kind = d.kind;
    document.getElementById('refTitle').textContent = d.title;
    document.getElementById('refFile').textContent = d.file.replace('../', '');
    document.getElementById('refOpen').href = d.file;
    const note = document.getElementById('refNote');
    note.hidden = !d.note;
    note.textContent = d.note || '';

    if (d.kind === 'Markdown') {
      this.body.className = 'ref-body md';
      this.body.innerHTML = '<p class="note">Loading…</p>';
      try {
        if (!this.cache.has(d.file)) {
          const r = await fetch(d.file, { cache: 'no-cache' });
          if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
          this.cache.set(d.file, md.parse(await r.text()));
        }
        if (this.current !== d.id) return;
        this.body.innerHTML = this.cache.get(d.file);
        this.body.querySelectorAll('a[href^="http"]').forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });
      } catch (e) {
        this.body.innerHTML = `<p class="empty">Could not read ${esc(d.file.replace('../', ''))} (${esc(e.message)}). Open the UI with start-ui.bat so the project folder is served.</p>`;
      }
    } else {
      this.body.className = `ref-body frame ${d.kind === 'PDF' ? 'pdf' : 'html'}`;
      this.body.innerHTML = `<iframe title="${esc(d.title)}" src="${d.file}"></iframe>`;
      const f = this.body.querySelector('iframe');
      if (d.kind !== 'PDF') f.addEventListener('load', () => {
        this.fitFrame();
        // the page keeps settling after load (web fonts, its own script), so follow its size
        try { new ResizeObserver(() => this.fitFrame()).observe(f.contentDocument.body); } catch { /* ignore */ }
      });
    }
  }

  // size the wiring diagram's frame to its content so the page scrolls as one
  fitFrame() {
    const f = this.body.querySelector('.html iframe, iframe');
    if (!f || this.body.classList.contains('pdf')) return;
    try {
      const doc = f.contentDocument;
      if (!doc) return;
      const h = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight || 0) + 4;
      if (Math.abs(f.offsetHeight - h) > 2) f.style.height = `${h}px`;
    } catch { /* cross-origin: keep the CSS height */ }
  }
}
