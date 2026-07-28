/**
 * Glass Shell workbench: rail · explorer · panel · work area with UNIFIED or
 * SPLIT (terminals-below) layouts, draggable splitters, layout presets,
 * viewers (md rendered⇄source, html, images) + terminal grid + Ask modal.
 *
 * Safety: dynamic strings flow through textContent; innerHTML receives only
 * static templates, the ICONS map, or marked() output of the operator's own
 * vault files.
 */

/* ── inline icon set (lucide-style strokes, static strings) ───────────────── */
const ICONS = {
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  explorer: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/>',
  panel: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/>',
  layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="14" x2="21" y2="14"/><line x1="12" y1="3" x2="12" y2="14"/>',
  term: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
  md: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>',
  html: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  img: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>',
  /* QUICK is a lightning bolt, not a rocket: the rocket is the DESIGNER's rail glyph (#34), so
     wearing it here made the card and its spawn row read as "designer". Worse, at 13-16px the
     rocket and the `design` pencil are the same shape — a diagonal stroke with a tail at the
     bottom-left — so the two were indistinguishable at the only size they ever render. */
  bolt: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  /* Spawn a session = a prompt with a plus. The neighbours decide this one: `robot` is two rows
     up (launch agent) and `term` is the card below (running sessions), so the glyph has to say
     "a NEW one of those" rather than "an agent" or "a terminal". A bare prompt+plus was tried
     and rejected: `term` is a bare prompt, so at 13px the two differed only by a small glyph
     floating beside them. The BOX is what carries the distinction at render size — a pane with
     a prompt inside and a plus at its corner, the convention every editor uses for a new
     terminal, which is exactly what this opens. Checked on a contact sheet at 13/15/16/22px
     against its neighbours rather than judged at 24. */
  spawn: '<rect x="2.5" y="5" width="13" height="14" rx="2.4"/><polyline points="5.6 10 8 12 5.6 14"/><path d="M19 3v6M16 6h6"/>',
  rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  chevR: '<polyline points="9 18 15 12 9 6"/>',
  chevL: '<polyline points="15 18 9 12 15 6"/>',
  chevD: '<polyline points="6 9 12 15 18 9"/>',
  box: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
  aios: '<rect x="2.5" y="2.5" width="19" height="19" rx="3"/><rect x="12.5" y="3.5" width="7.6" height="7.6" rx="1.4" fill="currentColor"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  folderOpen: '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H18a2 2 0 0 1 2 2v2"/>',
  expand: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>',
  compress: '<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>',
  robot: '<rect x="4" y="8" width="16" height="11" rx="2.5"/><path d="M12 8V4.7"/><circle cx="12" cy="3.5" r="1.1"/><circle cx="9.2" cy="13" r="1.05"/><circle cx="14.8" cy="13" r="1.05"/><path d="M2.7 12.5v3M21.3 12.5v3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  comfort: '<rect x="3" y="4.5" width="18" height="6" rx="1.6"/><rect x="3" y="13.5" width="18" height="6" rx="1.6"/>',
  compact: '<rect x="3" y="4" width="18" height="3.4" rx="1"/><rect x="3" y="10.3" width="18" height="3.4" rx="1"/><rect x="3" y="16.6" width="18" height="3.4" rx="1"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  star: '<polygon points="12 2 15.1 8.3 22 9.3 17 14.1 18.2 21 12 17.8 5.8 21 7 14.1 2 9.3 8.9 8.3 12 2"/>',
  /* A mortarboard: a skill is packaged know-how Claude LEARNS for a task. It used to be a
     lightning bolt — which is now QUICK's card glyph, so the card header and one of its own
     rows were the same shape. A puzzle piece is the obvious alternative and was rejected twice
     over: it collapses into a rounded cross at 13px, and "pluggable component" is what PLUGINS
     are (they own `box`) — worth keeping the two ideas visually apart. */
  skill: '<path d="M12 3.2 22 8l-10 4.8L2 8z"/><path d="M6 10.2V15c0 1.7 2.7 3 6 3s6-1.3 6-3v-4.8"/>',
  command: '<path d="M9 3a3 3 0 0 0-3 3 3 3 0 0 0 3 3h6a3 3 0 0 0 3-3 3 3 0 0 0-3-3 3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H9a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3z"/>',
  building: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4"/><path d="M8 6h.01M12 6h.01M16 6h.01M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  megaphone: '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  sliders: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  id: '<rect x="2" y="4" width="20" height="16" rx="2"/><circle cx="8" cy="10" r="2"/><path d="M6.5 16a2.5 2.5 0 0 1 5 0M14 9h4M14 13h3"/>',
  chart: '<line x1="12" y1="20" x2="12" y2="10"/><line x1="18" y1="20" x2="18" y2="4"/><line x1="6" y1="20" x2="6" y2="16"/>',
  sparkles: '<path d="M12 3l1.6 4.9L18.5 9l-4.9 1.1L12 15l-1.6-4.9L5.5 9l4.9-1.1z"/>',
  note: '<path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h9l7-7V5a2 2 0 0 0-2-2z"/><path d="M15 21v-6a1 1 0 0 1 1-1h6"/>',
  guide: '<circle cx="12" cy="12" r="9.5"/><polygon points="16.2 7.8 13.4 13.4 7.8 16.2 10.6 10.6 16.2 7.8"/>',
  wrench: '<path d="M14.6 6.4a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.7-3.7a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9l-3.7 3.7z"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2m-9 0 1 14h8l1-14"/>',
  sync: '<path d="M21 12a9 9 0 0 0-9-9 9 9 0 0 0-6.4 2.6L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9 9 0 0 0 6.4-2.6L21 16"/><path d="M21 21v-5h-5"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  design: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
};
function icon(name, size = 14) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ICONS.file}</svg>`;
}
function fileIconName(name) {
  if (/\.pdf$/i.test(name)) return 'file';
  if (/\.md$/i.test(name)) return 'md';
  if (/\.html?$/i.test(name)) return 'html';
  if (/\.(png|jpe?g|gif|svg|webp)$/i.test(name)) return 'img';
  return 'file';
}

/* ── i18n: window.i18n is injected by renderer/i18n.js (generated from the
   locale JSON). `t()` is the renderer's translate shorthand. The locale is set
   from shellConfig at boot (see initLocale); until then it defaults to 'en'. ─── */
const t = (key, vars) => (window.i18n ? window.i18n.t(key, vars) : key);
/* Resolve every data-i18n / data-i18n-title in the static HTML. Re-run on change. */
function applyStaticI18n(root = document) {
  for (const n of root.querySelectorAll('[data-i18n]')) n.innerHTML = t(n.getAttribute('data-i18n'));
  for (const n of root.querySelectorAll('[data-i18n-title]')) n.title = t(n.getAttribute('data-i18n-title'));
}

/* ── the pulse: PanelHost messages rendered NATIVELY (the iframe is gone) ──── */
window.glassShell.onPanelPost((msg) => renderPulse(msg));

/* ── shell config ─────────────────────────────────────────────────────────── */
let CLAUDE = 'claude';
let TERMFONT = 12.5;
/* xterm palette per theme — terminals follow the app theme (dark void / light paper). */
function termTheme(mode) {
  if (mode === 'light') return {
    background: '#faf9f6', foreground: '#34343b', cursor: '#ff5d4d', cursorAccent: '#faf9f6',
    selectionBackground: 'rgba(255,93,77,.20)',
    black: '#3b3b42', red: '#d6402c', green: '#1f9d57', yellow: '#a8740f', blue: '#2f6fd0',
    magenta: '#8a4fc8', cyan: '#1f8f95', white: '#5c5c66',
    brightBlack: '#8a8a93', brightRed: '#e0533f', brightGreen: '#27ab62', brightYellow: '#c98a1f',
    brightBlue: '#3f7fe0', brightMagenta: '#9a5fd8', brightCyan: '#2aa3a8', brightWhite: '#1c1c20',
  };
  return {
    background: '#101014', foreground: '#e6e6ea', cursor: '#ff5d4d', cursorAccent: '#101014',
    selectionBackground: 'rgba(255,93,77,.26)',
    black: '#1a1a1f', red: '#ff6b5e', green: '#3ec77a', yellow: '#e8b75a', blue: '#6cb0ff',
    magenta: '#c792ea', cyan: '#5fd7d0', white: '#d8d8de',
    brightBlack: '#5b5b66', brightRed: '#ff8a7f', brightGreen: '#63dd97', brightYellow: '#f3cd7e',
    brightBlue: '#92c7ff', brightMagenta: '#d9b1f0', brightCyan: '#84e6e0', brightWhite: '#ffffff',
  };
}
function applyTheme(mode) {
  document.body.classList.toggle('light', mode === 'light');
  const t = termTheme(mode);
  for (const [, p] of panes) if (p.kind === 'term' && p.term) p.term.options.theme = t;
}
let SHOWWK = true; // calendar week numbers (Glass parity; Settings toggle repaints live)
let KILLBEHAVIOR = 'ask'; // Glass parity: how the trash button behaves — ask | kill | capture (Settings changes it live)
let OPENNOTESIN = 'rendered'; // Glass "Open files in": a note opens rendered (default) or as raw source
void window.glassShell.shellConfig().then((c) => {
  CLAUDE = c.claudeCmd || 'claude';
  KILLBEHAVIOR = c.killBehavior || 'ask';
  OPENNOTESIN = c.openNotesIn || 'rendered';
  applyAppScale(c.appFontSize);
  applyHiddenCards(c.hiddenCards);
  TERMFONT = Number(c.termFontSize) || 12.5;
  applyTheme(c.theme || 'dark');
  EXPLORER.icons = c.fileIcons !== false;
  EXPLORER.autoReveal = c.autoReveal !== false;
  SHOWWK = c.showWeekNumbers !== false;
  if (pulse.lastMonth) paintCalendar(); // config may resolve after the first month message
});

/* Anchor a FIXED popup under an element, zoom-aware.
   Interface scale sets `body { zoom }`. getBoundingClientRect() reports VISUAL (zoomed)
   pixels, but a fixed child of the zoomed body is laid out in unzoomed px and then
   scaled — so writing rect coords straight into left/top pushes every menu right and
   down by the zoom factor. Divide by the zoom, and clamp so a menu near the bottom or
   right edge stays on screen. */
function uiZoom() {
  const z = parseFloat(getComputedStyle(document.body).zoom);
  return Number.isFinite(z) && z > 0 ? z : 1;
}
function anchorMenu(menu, rect, { gap = 4, width = 200 } = {}) {
  const z = uiZoom();
  const vw = window.innerWidth, vh = window.innerHeight;
  const left = Math.max(8, Math.min(rect.left, vw - width - 8));
  menu.style.left = (left / z) + 'px';
  menu.style.top = ((rect.bottom + gap) / z) + 'px';
  const h = menu.offsetHeight * z;                     // offsetHeight is unzoomed
  if (rect.bottom + gap + h > vh - 8) menu.style.top = (Math.max(8, vh - 8 - h) / z) + 'px';
}

/* Interface scale — the app's answer to "terminal font size" for the UI itself. Zooming
   the whole frame keeps every proportion and hairline intact (restyling ~200 px rules
   would drift); 13 reads as 100%. */
function applyAppScale(size) {
  const n = Math.min(18, Math.max(10, Number(size) || 13));
  // native page zoom, NOT css `body { zoom }` — css zoom leaves the coordinate space
  // unscaled, which skewed menu anchoring and xterm's mouse hit-testing
  void window.glassShell.setZoom(n / 13);
  document.body.style.zoom = '';   // clear any value a previous build left behind
  fitTerms();                      // the grid changes size with the zoom
}
/* Cards the operator switched off in Settings — hidden, never removed, so order and
   content survive a re-enable. */
function applyHiddenCards(list) {
  const hidden = new Set(Array.isArray(list) ? list : []);
  for (const card of document.querySelectorAll('#panel > .pcard')) {
    card.dataset.off = hidden.has(card.id) ? '1' : '';
    if (hidden.has(card.id)) card.style.display = 'none';
    else if (card.style.display === 'none') card.style.display = '';
  }
}

/* ── AI-58: explorer sort (per-folder overrides + master default) ─────────────
   The pref map roams via .glass/state.json (shared shape with Glass — see
   src/core/sort.ts). This mirror keeps the two pure lookups the renderer needs:
   closest-ancestor override resolution + the folders-first comparator. */
const SORT = { master: 'name', overrides: {} };
/* one boot fetch — paintExplorer awaits it so the first paint already uses the
   roamed prefs (a repaint-after would race the in-flight tree build) */
const SORT_READY = window.glassShell.sortState().then((s) => {
  SORT.master = s.master === 'mtime' ? 'mtime' : 'name';
  SORT.overrides = s.overrides || {};
}).catch(() => { /* defaults stand */ });
/* effective sort for a dir: its closest-ancestor override (longest match, any depth), else the master */
function resolveSortDir(dir) {
  let best = '';
  for (const r of Object.keys(SORT.overrides)) {
    if ((dir === r || dir.startsWith(r + '/')) && r.length > best.length) best = r;
  }
  const ov = best ? SORT.overrides[best] : undefined;
  return ov === 'name' || ov === 'mtime' ? ov : SORT.master;
}
/* folders first, both modes; mtime = newest-first with a stable name tiebreak */
function sortEntriesFor(entries, mode) {
  return entries.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    if (mode === 'mtime') { const d = (b.mtime || 0) - (a.mtime || 0); if (d !== 0) return d; }
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });
}
/* fs:list arrives UNSORTED (main stopped pre-sorting) — every consumer sorts here */
async function sortedList(dir) {
  return sortEntriesFor(await window.glassShell.fsList(dir), resolveSortDir(dir));
}


/* ── layout state ─────────────────────────────────────────────────────────── */
/* FOUR layouts, named on ONE axis — where the two docks sit. The old set mixed three
   vocabularies (Full = visibility, IDE = a tool category, Zen = a mood), and once three of
   the four show everything, "Full" stops distinguishing anything.

     Stacked  panel + explorer both left, work to the right
     Facing   panel left, explorer right, work between them
     IDE      explorer left, panel right — files-left is a universal editor convention,
              so the name encodes the side
     Zen      neither dock; work only

   Home is a TAB, never a layout. `split` is deliberately not a layout name — it already
   means the editor/terminal division in this same window. */
const LAYOUTS = ['Stacked', 'Facing', 'IDE', 'Zen']; // internal keys; display via layoutLabel()
const hasPanel = (pr = preset) => pr !== 'Zen';
const hasExplorer = (pr = preset) => pr !== 'Zen';
/* Which side each dock is on. Only these two know about sides — the splitter maths is
   position-based, so a dock's drag must mirror when it docks right. */
const panelRight = (pr = preset) => pr === 'IDE';
const explorerRight = (pr = preset) => pr === 'Facing';
const layoutLabel = (name) => t('layout.' + name.toLowerCase());
/* Position diagram for the layout menu. A name can carry character or precision, not both
   — the glyph carries precision, so "Facing" doesn't have to explain itself. Filled bar =
   the Glass panel, hollow bar = the explorer, empty space = the work area. */
const LAYOUT_BARS = {
  Stacked: [['fill', 2], ['hollow', 6]],
  Facing: [['fill', 2], ['hollow', 17]],
  IDE: [['hollow', 2], ['fill', 17]],
  Zen: [],
};
function layoutGlyph(name) {
  const bars = (LAYOUT_BARS[name] || []).map(([kind, x]) =>
    kind === 'fill'
      ? `<rect x="${x}" y="2.5" width="3.5" height="11" rx="1" fill="currentColor" stroke="none"/>`
      : `<rect x="${x + 0.4}" y="2.9" width="2.7" height="10.2" rx="0.8" fill="none" stroke="currentColor" stroke-width="1"/>`).join('');
  return `<svg width="22" height="16" viewBox="0 0 22 16" fill="none" stroke="currentColor" aria-hidden="true">`
    + `<rect x="0.6" y="0.6" width="20.8" height="14.8" rx="2.5" stroke-width="1" opacity=".55"/>${bars}</svg>`;
}
const layoutState = (() => {
  try { return JSON.parse(localStorage.getItem('shellLayout') || '{}'); } catch { return {}; }
})();
// 'Full' was renamed to 'Stacked' (same arrangement). Without this a returning operator's
// saved layout fails the includes() check and silently resets to the default.
const migratePreset = (v) => (v === 'Full' ? 'Stacked' : v);
let preset = LAYOUTS.includes(migratePreset(layoutState.preset)) ? migratePreset(layoutState.preset) : 'Stacked';
let split = layoutState.split !== false; // terminals-below ON by default — "editor up, terminal bottom"
let xw = layoutState.xw || 230;
/* The panel opens at its TIGHTEST width, not 380. It is a companion column, and the first thing
   a newcomer sees should give the work area the room — a wide panel on first launch reads as the
   app being mostly panel. 280 is the same floor the drag clamps to, so "narrowest" means one
   number, not two that can drift apart. A saved width still wins: this is the default for someone
   who has never dragged it, not a preference override. */
const PW_MIN = 280, PW_MAX = 560;
let pw = layoutState.pw || PW_MIN;
let th = layoutState.th || 0.38; // terminal zone fraction in split mode
// which panel layout to restore when leaving Zen — persisted, so a restart in Zen
// still remembers you were an IDE user
let lastPanelPreset = (() => {
  for (const v of [migratePreset(layoutState.lastPanelPreset), migratePreset(layoutState.preset)]) {
    if (LAYOUTS.includes(v) && hasPanel(v)) return v;
  }
  return 'Stacked';
})();
// panel visible WITHIN a panel layout — exactly symmetric with xOn for the explorer, so
// the title-bar toggle hides the panel without disturbing the layout or the explorer
let pOn = layoutState.pOn !== false;
/* Explorer visible WITHIN a panel layout — the folder button toggles only this, never the panel
   (clicking it used to flip the whole preset, which hid the panel too).
   FIRST RUN STARTS HIDDEN. A newcomer's first screen showed a file tree of a vault they have not
   created yet, competing for attention with the one thing they need to look at. `!== false` made
   "no saved state" mean "on", which is the right default for a returning operator and the wrong
   one for a first launch — so the two cases are now distinguished: an explicit saved preference
   is honoured, and the absence of one starts quiet. */
let xOn = 'xOn' in layoutState ? layoutState.xOn !== false : false;

function saveLayout() {
  try { localStorage.setItem('shellLayout', JSON.stringify({ preset, split, xw, pw, th, xOn, lastPanelPreset, pOn })); } catch { /* ignore */ }
}

function applyLayout() {
  const x = document.getElementById('xwrap');
  const p = document.getElementById('panel');
  const showX = hasExplorer() && xOn; // Zen hides it; otherwise the folder button decides
  const showP = hasPanel() && pOn;
  // Position comes from CSS `order` on the flex row, NOT from moving nodes: reparenting
  // #panel/#work would tear down every live terminal and browser pane inside them.
  const appEl = document.getElementById('app');
  appEl.classList.toggle('ide', preset === 'IDE');
  appEl.classList.toggle('facing', preset === 'Facing');

  x.style.display = showX ? '' : 'none';
  document.getElementById('xsplit').style.display = showX ? '' : 'none';
  p.style.display = showP ? '' : 'none';
  document.getElementById('psplit').style.display = showP ? '' : 'none';
  x.style.width = xw + 'px';
  p.style.width = pw + 'px';
  const dp = document.getElementById('dragPanel');
  dp.classList.toggle('on', showP);
  dp.innerHTML = icon('panel', 15);
  dp.title = t(showP ? 'panel.hide' : 'panel.show');
  const rx = document.getElementById('railExplorer');
  rx.classList.toggle('on', showX);
  rx.innerHTML = icon(showX ? 'folderOpen' : 'folder', 15); // open folder when the explorer is showing
  applySplit();
  saveLayout();
  fitTerms();
}

function applySplit() {
  const tz = document.getElementById('termzone');
  const vz = document.getElementById('viewzone');
  const hs = document.getElementById('hsplit');
  const anyTerm = [...panes.values()].some((p) => p.kind === 'term');
  const anyMain = [...panes.values()].some((p) => zoneOf(p) === 'main');
  const show = split && anyTerm; // empty dock = invisible dock (less cockpit)
  /* The editor zone earns the same rule the dock has always had. It used to stay open when
     empty, which is what let the welcome state paint over an expanded terminal: expand only
     redistributes (th → 0.93), so the zone survived as a ~7% sliver too short for its own
     content, and a centred flex box spills both ways out of a box it does not fit.
     Hiding it removes the overlap by construction rather than clipping it.
     The AND is load-bearing: with NO terminal either, the welcome IS the window — an app
     that opens to nothing at all would be worse than one with a stray logo. */
  const showMain = anyMain || !show;
  vz.style.display = showMain ? '' : 'none';
  tz.style.display = show ? '' : 'none';
  hs.style.display = (show && showMain) ? '' : 'none';
  // Sole survivor takes the whole work area — otherwise a hidden editor leaves th's
  // remainder as dead space below the terminal.
  tz.style.height = showMain ? Math.round(th * 100) + '%' : '100%';
  // re-home every pane + tab to its zone
  for (const [id, p] of panes) homePane(id, p);
  ensureActive('main');
  if (split) ensureActive('term');
  paintExpandButtons();
}

/* ═══ the pulse renderer — nudge · quota · sessions · calendar · learned · outputs ═══ */
const pulse = {
  nudgeDismissed: new Set(),
  lastInbox: [],        // "Needs you": sync items (sessions · suggestions · nudge)
  lastInboxUpdate: null, // "Needs you": the async framework-update row
  calCur: null,
  calView: (() => { try { return localStorage.getItem('calView') === 'week' ? 'week' : 'month'; } catch { return 'month'; } })(),
  weekIdx: -1,
  pendingWeek: null,
  runCollapsed: new Set((() => { try { return JSON.parse(localStorage.getItem('runCollapsed') || '[]'); } catch { return []; } })()),
  collapsed: new Set((() => { try { return JSON.parse(localStorage.getItem('pulseCollapsed') || '[]'); } catch { return []; } })()),
  send: (m) => window.glassShell.panelSend(m),
  cmd: (command, ...args) => window.glassShell.panelSend({ type: 'cmd', command, args }),
};
/* Each card gets its own glyph. The title used to carry a shared 5px coral dot (.ptitle::before)
   — fine expanded, useless collapsed, where eleven identical dots identify nothing. Keys
   are the card ids, so the icon travels with the card through reordering and collapse. */
const CARD_ICONS = {
  pInbox: 'inbox',       // needs you
  pDaily: 'note',        // today's note
  pCal: 'calendar',
  pQuick: 'bolt',        // quick actions — NOT rocket, that is the Designer's glyph
  pRun: 'term',          // running sessions
  pAbout: 'id',          // about you
  pSpaces: 'users',      // shared spaces
  pLearn: 'sparkles',    // what Claude learned
  pOut: 'box',           // shipped
  pReports: 'chart',
  pHealth: 'check',
};
function cardIcon(key) { return CARD_ICONS[key] || 'star'; }

function pulseTitle(card, key, text, count) {
  const ti = el('div', 'ptitle', text);
  const ic = el('span', 'ptcon');   // NOT .picon — that class already styles panel ROW icons
  ic.innerHTML = icon(cardIcon(key), 12);
  ti.prepend(ic);
  ti.tabIndex = 0;
  if (count) ti.appendChild(el('span', 'pcount', String(count)));
  // reorder controls (↑↓) — every pulse card is movable; ⌥↑↓ from the keyboard too
  const mv = el('span', 'pmove');
  const up = el('button', '', '↑'); up.title = t('pulse.moveUp');
  const dn = el('button', '', '↓'); dn.title = t('pulse.moveDown');
  up.addEventListener('click', (e) => { e.stopPropagation(); moveCard(card, -1); });
  dn.addEventListener('click', (e) => { e.stopPropagation(); moveCard(card, 1); });
  mv.append(up, dn);
  ti.appendChild(mv);
  const collapsed = pulse.collapsed.has(key);
  card.classList.toggle('pcollapsed', collapsed);
  ti.addEventListener('click', () => {
    const on = !card.classList.contains('pcollapsed');
    card.classList.toggle('pcollapsed', on);
    if (on) pulse.collapsed.add(key); else pulse.collapsed.delete(key);
    try { localStorage.setItem('pulseCollapsed', JSON.stringify([...pulse.collapsed])); } catch { /* ignore */ }
  });
  ti.addEventListener('keydown', (e) => {
    if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); moveCard(card, -1); }
    else if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); moveCard(card, 1); }
  });
  return ti;
}

/* ── pulse card reordering — drag-free ↑↓ within the panel, persisted ───────── */
function movablePulseCards() {
  return Array.from(document.querySelectorAll('#panel > .pcard'));
}
function persistPulseOrder() {
  try { localStorage.setItem('pulseOrder', JSON.stringify(movablePulseCards().map((c) => c.id))); } catch { /* ignore */ }
}
function moveCard(card, dir) {
  const list = movablePulseCards();
  const i = list.indexOf(card);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= list.length) return;
  const ref = list[j];
  if (dir < 0) ref.parentNode.insertBefore(card, ref);
  else ref.parentNode.insertBefore(card, ref.nextSibling);
  persistPulseOrder();
  const t = card.querySelector('.ptitle'); if (t) t.focus();
}
function applyPulseOrder() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem('pulseOrder') || 'null'); } catch { saved = null; }
  if (!Array.isArray(saved) || !saved.length) return;
  const cards = movablePulseCards();
  const domIds = cards.map((c) => c.id);
  const target = saved.filter((k) => domIds.includes(k)).concat(domIds.filter((k) => !saved.includes(k)));
  for (let i = 0; i < target.length; i++) {
    const cur = movablePulseCards();
    if (cur[i] && cur[i].id !== target[i]) {
      const node = cur.find((c) => c.id === target[i]);
      if (node) cur[i].parentNode.insertBefore(node, cur[i]);
    }
  }
}
function toggleAllPulse() {
  const cards = ['pRun', 'pCal', 'pLearn', 'pOut'];
  const anyOpen = cards.some((id) => !document.getElementById(id).classList.contains('pcollapsed'));
  for (const id of cards) {
    document.getElementById(id).classList.toggle('pcollapsed', anyOpen);
    if (anyOpen) pulse.collapsed.add(id); else pulse.collapsed.delete(id);
  }
  try { localStorage.setItem('pulseCollapsed', JSON.stringify([...pulse.collapsed])); } catch { /* ignore */ }
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function fmtMem(mb) {
  if (!mb || mb < 1) return '';
  return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb + ' MB';
}
function fmtAgo(ts) {
  if (!ts) return '';
  const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
  if (m < 1) return 'now';
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '');
  return Math.floor(h / 24) + 'd';
}

function renderPulse(msg) {
  if (msg.type === 'state') renderPulseState(msg);
  else if (msg.type === 'running') renderPulseRunning(msg);
  else if (msg.type === 'month') renderPulseMonth(msg.data);
  else if (msg.type === 'updateStatus') renderPulseUpdate(msg);
  else if (msg.type === 'calendarDirty') { if (pulse.calCur) pulse.send({ type: 'navMonth', year: pulse.calCur.year, month: pulse.calCur.month }); }
  else if (msg.type === 'toggleAllCards') toggleAllPulse();
}

function renderPulseState(m) {
  window.__pulseReady = true;
  // secondary hints (the small .pbkey subtitles under each card) — gate on the
  // setting, live on every state (a Settings toggle re-emits state via postState)
  document.body.classList.toggle('no-hints', m.showHints === false);
  // "Needs you" inbox — consolidated attention (sessions on input · suggestions ·
  // nudge · update badge) with stateful dismissal persisted in .glass/state.json
  pulse.lastInbox = m.inbox || [];
  renderInboxCard();
  // nudge — grey glass whisper (hidden while the inbox card carries the nudge)
  const inboxHasNudge = pulse.lastInbox.some((i) => i.kind === 'nudge');
  const n = document.getElementById('pNudge');
  if (m.nudge && !inboxHasNudge && !pulse.nudgeDismissed.has(m.nudge.kind)) {
    n.replaceChildren();
    const x = el('span', 'nx', '×');
    x.addEventListener('click', (e) => { e.stopPropagation(); pulse.nudgeDismissed.add(m.nudge.kind); n.style.display = 'none'; });
    n.appendChild(x);
    n.appendChild(el('span', 'nico', m.nudge.icon));
    if (m.nudge.cmdLabel) { n.appendChild(el('b', '', m.nudge.cmdLabel + ' ')); }
    n.appendChild(document.createTextNode(m.nudge.label || ''));
    n.onclick = () => { pulse.send({ type: 'nudgeRun', kind: m.nudge.kind, command: m.nudge.command }); };
    n.style.display = 'block';
    feedMark(n, 'nudge', m.nudge.kind + '|' + (m.nudge.label || ''));
  } else n.style.display = 'none';
  // learned
  const L = document.getElementById('pLearn');
  L.replaceChildren();
  L.appendChild(pulseTitle(L, 'pLearn', t('pulse.claudeLearned')));
  // #37 rows use the SAME vocabulary as every other card (icon · label · key · badge)
  // instead of a bespoke two-line item with no icon and no badge.
  for (const it of (m.learnings || []).slice(0, 4)) {
    const r = pbtn(L, { emoji: 'skill', label: it.title, key: it.source, val: it.date, onClick: () => pulse.cmd('aios.openLearning', it.file, it.line) });
    feedMark(r, 'learn', (it.file || '') + '#' + (it.line || '') + '#' + it.title);
  }
  L.style.display = (m.learnings || []).length && !L.dataset.off ? '' : 'none'; // empty OR switched off in Settings
  // outputs
  const O = document.getElementById('pOut');
  O.replaceChildren();
  O.appendChild(pulseTitle(O, 'pOut', t('pulse.recentOutputs')));
  for (const o of (m.outputs || []).slice(0, 5)) {
    const ext = (o.name.split('.').pop() || '').toLowerCase();
    const r = pbtn(O, { emoji: fileIconName(o.name), label: o.name, key: o.group, val: ext && ext !== o.name.toLowerCase() ? ext : '', onClick: () => pulse.cmd('aios.openOutput', o.path) });
    feedMark(r, 'out', o.path);
  }
  O.style.display = (m.outputs || []).length && !O.dataset.off ? '' : 'none';
  // the action cards (the extension's Quick / Daily / Workspaces / Context / Reports)
  pulse.lastState = m;
  pulse.goAgents = m.goAgents || 0;
  updateAgentBadge(m.goAgents);
  renderActionCards(m);
  feedPrime('nudge', 'learn', 'out', 'rep'); // boot render isn't "new" — animate only from here on
  if (pulse.lastRunning) renderPulseRunning(pulse.lastRunning);
}

/* ═══ "Needs you" — ONE card for everything waiting on the operator ═══
   Sessions blocked on input · open go-with-agents suggestions · the active
   nudge · the framework-update badge. Dismissal (×) is STATEFUL: it hides an
   item until it changes again (persisted in .glass/state.json; the signature
   comparison lives in main — src/core/inbox.ts). */
function inboxRows() {
  const rows = [...(pulse.lastInbox || [])];
  if (pulse.lastInboxUpdate) rows.push(pulse.lastInboxUpdate);
  return rows;
}
function inboxAction(item) {
  if (item.kind === 'session') { pulse.cmd('aios.revealAgent', item.name); return; }
  if (item.kind === 'suggestion') { void pickSuggestion(); return; }
  if (item.kind === 'nudge') { pulse.send({ type: 'nudgeRun', kind: item.nudgeKind, command: item.command }); return; }
  if (item.kind === 'update') pulse.cmd('aios.updateFramework');
}
function renderInboxCard() {
  const I = document.getElementById('pInbox');
  if (!I) return;
  const rows = inboxRows();
  I.replaceChildren();
  if (!rows.length) { I.style.display = 'none'; return; }
  I.style.display = '';
  I.appendChild(pulseTitle(I, 'pInbox', t('pulse.inbox'), rows.length));
  for (const item of rows) {
    const r = el('div', 'pinrow');
    const dot = el('span', 'pindot ' + (item.kind === 'session' ? 'st-input' : item.kind === 'update' ? 'st-warn' : 'st-idle'));
    r.appendChild(dot);
    r.appendChild(el('span', 'pinico', item.icon || ''));
    const tx = el('span', 'pintext');
    tx.appendChild(el('span', 'pinlab', item.label));
    if (item.detail) tx.appendChild(el('span', 'pindet', item.detail));
    r.appendChild(tx);
    const x = el('button', 'pinx', '×');
    x.title = t('inbox.dismissTitle');
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      pulse.send({ type: 'inboxDismiss', key: item.key, sig: item.sig });
      // optimistic: drop locally now; main re-posts the filtered truth right after
      if (item.kind === 'update') pulse.lastInboxUpdate = null;
      else pulse.lastInbox = (pulse.lastInbox || []).filter((i) => i.key !== item.key);
      renderInboxCard();
    });
    r.appendChild(x);
    r.addEventListener('click', () => inboxAction(item));
    feedMark(r, 'inbox', item.key + '|' + item.sig);
    I.appendChild(r);
  }
  feedPrime('inbox');
}

/* ── panel action button — the extension's `.btn` (label · key · count) ─────── */
function pbtn(parent, { emoji, label, key, val, onClick, accent }) {
  const b = el('button', 'pbtn' + (accent ? ' accent' : ''));
  if (emoji) { const pe = el('span', 'pbemoji'); pe.innerHTML = icon(emoji, 15); b.appendChild(pe); }
  b.appendChild(el('span', 'pblabel', label));
  if (key) b.appendChild(el('span', 'pbkey', key));
  if (val !== undefined && val !== null && val !== '') b.appendChild(el('span', 'pbval', String(val)));
  b.addEventListener('click', onClick);
  parent.appendChild(b);
  return b;
}

/* The pulse's action cards. Every click reuses a flow that already exists —
   these surfaces ARE the extension's Home buttons, shell-native. */
function renderActionCards(m) {
  // ── Start: launch the primary session · resume · ask ──
  const S = document.getElementById('pStart');
  S.replaceChildren();
  const primary = m.primary || 'aios';
  // ── Greeting — rendered ABOVE the toolbar (its own #pGreet, right under the brand),
  //    so the panel opens with a human line before any controls (#34) ──
  const G = document.getElementById('pGreet');
  if (G) {
    G.replaceChildren();
    const gh = new Date().getHours();
    const salute = gh < 12 ? t('home.morning') : gh < 19 ? t('home.afternoon') : t('home.evening');
    // A brand-new vault has no name yet (no about_me, no Identity row) — greet without
    // one rather than addressing the operator as "aios".
    const who = (m.operator || '').trim();
    const gline = el('div', 'pgreet-line', who ? salute + ', ' : salute);
    if (who) gline.appendChild(el('span', 'taccent', who));
    G.appendChild(gline);
  }
  const ask = el('button', 'pbig'); ask.textContent = t('pulse.askBig');
  ask.title = t('pulse.askBigTitle');
  ask.addEventListener('click', () => void onIntentAsk());
  S.appendChild(ask);
  const lr = el('div', 'pstartrow');
  // a vault with no Identity row falls back to 'aios' — render it as the brand, not a
  // lowercase handle, so the button never reads "Launch aios"
  const launch = el('button', 'pbtn primary'); launch.textContent = t('pulse.launch', { name: primary === 'aios' ? 'AIOS' : primary });
  launch.addEventListener('click', () => launchPrimary(primary));
  const resume = el('button', 'pbtn'); resume.textContent = t('pulse.resume');
  resume.addEventListener('click', () => void createPane({ name: 'resume', cmd: CLAUDE + ' --resume' }));
  lr.append(launch, resume);
  S.appendChild(lr);
  // go-with-agents is a toolbar button with a count badge now (Glass parity) — no
  // conditional card, so nothing appears/disappears in the Start block.

  // ── Daily: discipline compounds ──
  const D = document.getElementById('pDaily');
  D.replaceChildren();
  D.appendChild(pulseTitle(D, 'pDaily', t('pulse.daily')));
  pbtn(D, { emoji: 'sun', label: t('pulse.planDay'), key: '/today', onClick: () => void runWhere('/aios:today', 'today') });
  pbtn(D, { emoji: 'logout', label: t('pulse.closeSession'), key: '/close-session', onClick: () => void runWhere('/aios:close-session', 'close-session') });
  pbtn(D, { emoji: 'moon', label: t('pulse.closeDay'), key: '/close-day', onClick: () => void runWhere('/aios:close-day', 'close-day') });

  // ── Quick: the doers ──
  const Q = document.getElementById('pQuick');
  Q.replaceChildren();
  Q.appendChild(pulseTitle(Q, 'pQuick', t('pulse.quick')));
  pbtn(Q, { emoji: 'star', label: t('pulse.frequent'), key: t('pulse.frequentKey'), val: m.frequent, onClick: () => void pickFrequent() });
  pbtn(Q, { emoji: 'robot', label: t('pulse.launchAgent'), key: t('pulse.launchAgentKey'), val: m.agents, onClick: () => void pickAgent() });
  pbtn(Q, { emoji: 'skill', label: t('pulse.loadSkill'), key: t('pulse.loadSkillKey'), val: m.skills, onClick: () => void pickSkill() });
  pbtn(Q, { emoji: 'command', label: t('pulse.runCommand'), key: t('pulse.runCommandKey'), val: m.commands, onClick: () => void pickCommand() });
  pbtn(Q, { emoji: 'download', label: t('pulse.ingest'), key: t('pulse.ingestKey'), onClick: () => void ingestFlow() });
  pbtn(Q, { emoji: 'spawn', label: t('pulse.spawn'), key: t('pulse.spawnKey'), onClick: () => void spawnWorkerFlow() });
  // Marketplace is hidden until it actually exists (#39) — an empty storefront is
  // worse than none. Re-enable this row (and the menu) when the partner shelf is real.

  // ── Workspaces ──
  const W = document.getElementById('pSpaces');
  W.replaceChildren();
  W.appendChild(pulseTitle(W, 'pSpaces', t('pulse.workspaces')));
  pbtn(W, { emoji: 'building', label: t('pulse.companies'), key: t('pulse.companiesKey'), val: (m.companies || []).length || '—', onClick: () => void companyActionFlow(m.companies || []) });
  pbtn(W, { emoji: 'users', label: t('pulse.collaboration'), key: t('pulse.collaborationKey'), val: (m.collab || []).length || '—', onClick: () => void collaborateActionFlow() });
  pbtn(W, { emoji: 'folder', label: t('pulse.projects'), key: t('pulse.projectsKey'), val: m.projects || '—', onClick: () => void pickContext('projects') });

  // ── About you: declared / observed / personalizations ──
  const A = document.getElementById('pAbout');
  A.replaceChildren();
  A.appendChild(pulseTitle(A, 'pAbout', t('pulse.aboutYou')));
  pbtn(A, { emoji: 'megaphone', label: t('pulse.declared'), key: t('pulse.declaredKey'), val: m.declared || '—', onClick: () => void pickContext('declared') });
  pbtn(A, { emoji: 'search', label: t('pulse.observed'), key: t('pulse.observedKey'), val: m.observed || '—', onClick: () => void pickContext('observed') });
  pbtn(A, { emoji: 'sliders', label: 'INTENT.md', key: t('pulse.intentKey'), onClick: () => openFrameworkDoc('INTENT.md') });
  pbtn(A, { emoji: 'id', label: 'USER.md', key: t('pulse.userKey'), onClick: () => openFrameworkDoc('USER.md') });

  // ── Reports: recent + create new ──
  const R = document.getElementById('pReports');
  R.replaceChildren();
  R.appendChild(pulseTitle(R, 'pReports', t('pulse.reports')));
  pbtn(R, { emoji: 'chart', label: t('pulse.generateReport'), key: t('pulse.generateReportKey'), onClick: () => void reportsFlow() });
  // recent reports read like the Generate row above them (#37) — same icon slot,
  // label weight and badge pill, not a bare one-line item
  for (const r of (m.reports || []).slice(0, 4)) {
    const ext = (r.name.split('.').pop() || '').toLowerCase();
    const it = pbtn(R, { emoji: fileIconName(r.name), label: r.name, key: t('pulse.reportRecent'), val: ext && ext !== r.name.toLowerCase() ? ext : '', onClick: () => void openViewer(r.path) });
    feedMark(it, 'rep', r.path);
  }
}

async function onIntentAsk() {
  const intent = await askWithChips();
  if (!intent) return;
  const slugged = ('ask-' + intent.toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, 28).replace(/-+$/, '');
  const prompt = `Find the right AIOS action for this intent and run it: "${intent}". Search my agents, /aios: commands, skills, and frequent tasks; pick the best match, tell me in one line which you chose and why, then execute it.`;
  await createPane({ name: slugged, cmd: `${CLAUDE} --name ${slugged} ${shq(prompt)}` });
}

async function openFrameworkDoc(file) {
  const root = await window.glassShell.vaultRoot();
  if (!root) { toast(t('viewer.noVault')); return; }
  // vaultRoot may be the framework root or its /vault subdir — the docs live at framework root
  const fwRoot = root.endsWith('/vault') ? root.slice(0, -'/vault'.length) : root;
  void openViewer(fwRoot + '/' + file);
}

/* ═══ Health — the ongoing twin of Setup (Setup = day one, Health = every day
   after). Six doctor-backed rows, each green (pass) or amber (needs attention),
   each with a one-click fix that is NEVER fire-and-forget: headless repairs
   re-run the same check as proof (doctor:repair); operator-in-the-loop fixes
   open a visible terminal and re-check when that terminal exits. ═══ */
const healthFixPanes = new Set(); // pty ids of open fix terminals → re-check on exit
let healthChecking = false;

async function refreshHealth() {
  const H = document.getElementById('pHealth');
  if (!H || healthChecking) return;
  healthChecking = true;
  let rows = [];
  try { rows = await window.glassShell.doctorHealth(); } catch { rows = []; } finally { healthChecking = false; }
  H.replaceChildren();
  const title = pulseTitle(H, 'pHealth', t('pulse.health'));
  // a quiet re-check control rides with the reorder arrows (visible on hover)
  const mv = title.querySelector('.pmove');
  if (mv) {
    const re = el('button', '', '↻'); re.title = t('health.recheck');
    re.addEventListener('click', (e) => { e.stopPropagation(); void refreshHealth(); });
    mv.prepend(re);
  }
  H.appendChild(title);
  for (const c of rows) {
    const r = el('div', 'phrow');
    r.appendChild(el('span', 'phdot ' + (c.status === 'pass' ? 'st-ok' : 'st-warn')));
    r.appendChild(el('span', 'phlab', c.label));
    const msg = el('span', 'phmsg', c.message);
    msg.title = c.message + (c.repairHint ? '\n→ ' + c.repairHint : '');
    r.appendChild(msg);
    if (c.status !== 'pass' && (c.canRepair || c.repairCmd)) r.appendChild(healthFixButton(c));
    feedMark(r, 'health', c.id + '|' + c.status);
    H.appendChild(r);
  }
  H.style.display = rows.length ? '' : 'none';
  feedPrime('health');
}

function healthFixButton(c) {
  const fx = el('button', 'phfix', t('health.fix'));
  fx.title = c.repairHint || '';
  fx.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (c.canRepair) {
      // headless repair → the doctor re-runs the SAME check and returns proof
      fx.disabled = true; fx.textContent = t('health.fixing');
      const proved = await window.glassShell.doctorRepair(c.id).catch(() => null);
      toast(proved && proved.status === 'pass' ? t('health.fixed', { label: c.label }) : t('health.stillFailing', { label: c.label }));
      void refreshHealth();
    } else {
      // operator-in-the-loop fix: visible terminal; onPtyExit re-checks (below)
      const pid = await createPane({ name: 'fix-' + c.id, cmd: c.repairCmd });
      healthFixPanes.add(pid);
    }
  });
  return fx;
}

/* Registry status → {dot class, label, tooltip}. A registered, alive session is
   NEVER the grey "unknown" dot (that's reserved for plain terminals) — an
   app-specific status like `shell` reads as green "ready", not unknown.
   (Ported from aios-glass v0.2.0.) */
function statusInfo(raw) {
  const st = (raw || '').toLowerCase();
  if (st === 'busy' || st === 'working' || st === 'running') return { cls: 'busy', label: t('status.working'), title: t('status.workingTitle') };
  if (/wait|input|prompt|\bask\b|attention|approv|permission|block/.test(st)) return { cls: 'input', label: t('status.needsInput'), title: t('status.needsInputTitle') };
  if (/error|fail|crash/.test(st)) return { cls: 'error', label: st, title: t('status.errorTitle') };
  return { cls: 'idle', label: t('status.ready'), title: t('status.readyTitle') };
}

/* ═══ live-run theater — narrate work honestly (no fabricated tool counts) ═══
   Registry grade (all sessions, zero new plumbing): shimmer "Working" verb +
   live elapsed, tracked from status flips on the 2s poll. Pty grade (only the
   terminals THIS window spawned): a one-line ticker tails the latest output. */
const theater = new Map(); // session name → { busySince, lastDur }
function trackTheater(sessions) {
  const now = Date.now();
  for (const a of sessions) {
    const busy = statusInfo(a.status).cls === 'busy';
    const st = theater.get(a.name) || { busySince: 0, lastDur: 0 };
    // first seen already busy → the registry's updatedAt is when the status flipped
    if (busy && !st.busySince) st.busySince = a.updatedAt || a.startedAt || now;
    else if (!busy && st.busySince) { st.lastDur = Math.max(0, now - st.busySince); st.busySince = 0; }
    theater.set(a.name, st);
  }
}
function fmtDur(ms) {
  const m = Math.max(1, Math.round(ms / 60000));
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  return h < 24 ? h + 'h' + (m % 60 ? ' ' + (m % 60) + 'm' : '') : Math.floor(h / 24) + 'd';
}
/* strip ANSI/OSC noise and pull the last human-meaningful line from a pty chunk */
const ANSI_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b[@-Z\\^_-]/g;
function lastPtyLine(chunk) {
  const lines = String(chunk).replace(ANSI_RE, '').split(/[\r\n]+/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = lines[i].replace(/[\x00-\x1f\x7f]/g, '').trim();
    if (s.length > 2 && /[a-zA-Z0-9]/.test(s)) return s.slice(0, 140);
  }
  return '';
}
/* the ticker: a 15px window; new lines slide in, the old line slides out */
function buildTicker(key, line) {
  const box = el('span', 'ticker');
  box.dataset.tick = key;
  box.dataset.line = line || '';
  if (line) box.appendChild(el('span', 'tickline still', line)); // re-render repaint = no re-animation
  return box;
}
function tickTicker(key, line) {
  for (const box of document.querySelectorAll('.ticker')) {
    if (box.dataset.tick !== key || box.dataset.line === line) continue;
    box.dataset.line = line;
    const old = box.querySelector('.tickline:not(.out)');
    if (old) { old.classList.add('out'); setTimeout(() => old.remove(), 340); }
    box.appendChild(el('span', 'tickline', line));
  }
}

/* ═══ feed-entry motion — new pulse rows announce themselves once ═══
   First render of each collection primes silently (boot isn't "new"); after
   that, unseen keys get .is-new (fade + drop-in + fading accent edge). */
const FEED = { primed: new Set(), seen: new Set() };
function feedMark(node, coll, key) {
  const k = coll + ' ' + key;
  if (FEED.seen.has(k)) return;
  FEED.seen.add(k);
  if (!FEED.primed.has(coll)) return;
  node.classList.remove('is-new'); void node.offsetWidth; // retrigger on reused nodes (nudge)
  node.classList.add('is-new');
}
function feedPrime(...colls) { for (const c of colls) FEED.primed.add(c); }

/* The RUNNING card (Glass's "Running"): quota · Sessions (registry-wide) ·
   Terminals (this window's panes). Re-renders on the 2s poll AND on pane open/close. */
function renderPulseRunning(m) {
  if (m && Array.isArray(m.running)) {
    pulse.lastRunning = m;
    /* A session ENDS when the registry says so — not when a title looks unfamiliar. This is
       the positive evidence the title listener cannot give: a pane that once carried a
       confirmed session name, whose name is no longer live, is a shell now. Ctrl+C twice
       lands here on the next pulse. */
    const liveNames = new Set(m.running.map((a) => a.name));
    for (const [pid, pane] of panes) {
      if (pane.kind !== 'term' || !pane.confirmedName) continue;
      if (liveNames.has(pane.confirmedName)) continue;
      pane.isSession = false;
      const was = pane.confirmedName;
      pane.confirmedName = null;
      renamePane(pid, t('tab.endedSession', { name: was }));
    }
  }
  const data = pulse.lastRunning || {};
  const sessions = data.running || [];
  trackTheater(sessions);
  // registry-grade theater on the pane headers: a busy owned session's tab name shimmers
  for (const [, p] of panes) {
    if (p.kind !== 'term') continue;
    const live = sessions.find((a) => a.name === p.name);
    const nm = p.tab.querySelector('.tname');
    if (nm) nm.classList.toggle('shimverb', !!live && !p.exited && statusInfo(live.status).cls === 'busy');
  }
  // Terminals = plain-shell panes only. A pane whose name matches a live registry
  // session is a claude SESSION (already shown in the Sessions section above), not a
  // terminal — exclude it here so sessions don't double-show as terminals (#2).
  const terms = [...panes.entries()].filter(([, p]) => p.kind === 'term' && !sessions.some((a) => a.name === p.name));
  const R = document.getElementById('pRun');
  R.replaceChildren();
  R.appendChild(pulseTitle(R, 'pRun', t('pulse.running'))); // counts live in the Sessions/Terminals sub-headers
  document.getElementById('pQuota').style.display = 'none'; // quota now lives inside this card

  const q = data.quota || {};
  if (q.has) R.appendChild(buildQuotaRow(q));

  runSection(R, t('pulse.sessions'), 'sessions', sessions.length, () => void spawnWorkerFlow(), t('pulse.spawnSession'), (box) => {
    for (const a of sessions) { const r = sessionRow(a); feedMark(r, 'sess', a.name); box.appendChild(r); }
    if (!sessions.length) box.appendChild(el('div', 'psubempty', t('pulse.noSessions')));
  }, null); // close-all now lives in the panel toolbar (Glass placement), not this header
  runSection(R, t('pulse.terminals'), 'terminals', terms.length, () => void createPane({ name: 'terminal' }), t('pulse.newTerminal'), (box) => {
    for (const [tid, p] of terms) { const r = terminalRow(tid, p); feedMark(r, 'term', tid); box.appendChild(r); }
    if (!terms.length) box.appendChild(el('div', 'psubempty', t('pulse.noTerminals')));
  });
  feedPrime('sess', 'term');
  // close-all is only offered when there's something to close (Glass hides it at 0)
  const cab = document.getElementById('railCloseAll');
  if (cab) { cab.hidden = sessions.length === 0; cab.title = t('pulse.closeAll'); }
  void refreshNoteCounts();
}
/* #19 note counts drive the persistent badge — fetched once per render, repainting
   only when they actually changed (so this can't loop against paintRunning). */
async function refreshNoteCounts() {
  let counts = {};
  try { counts = await window.glassShell.notesCounts(); } catch { return; }
  const before = JSON.stringify(pulse.noteCounts || {});
  if (JSON.stringify(counts) === before) return;
  pulse.noteCounts = counts;
  renderPulseRunning();
}
function paintRunning() { renderPulseRunning(); }

/* ═══ "Close all sessions" — the Glass closeAll broadcast, shell-native ═══
   Wraps up every live session EXCEPT the operator's primary: each in-window
   pane gets `/aios:close-session --auto` typed into its own pty (the app owns
   its node-pty sessions, so the broadcast is a direct write); sessions running
   OUTSIDE this window get a graceful SIGTERM by pid (we have no tty to type
   into — same lane as the per-row close). The primary is never touched: it's
   where /close-day consolidates afterwards (Glass kill-scope contract:
   selected minus primary). */
async function closeAllSessions(sessions) {
  const cfg = await window.glassShell.shellConfig();
  const primary = cfg.primary || 'aios';
  if (!sessions.length) { toast(t('pulse.closeAllNone')); return; }
  // A SELECTOR, never a nuke (Glass closeAll contract). All sessions selected by
  // default — uncheck any to keep it open — plus two OPTIONAL post-actions, both
  // OFF: run /close-day, and kill the terminals (never the primary). Firing at
  // everything with no confirmation is exactly the mistake this replaces.
  const items = sessions.map((a) => ({
    label: a.name + (a.name === primary ? ' · ' + t('pulse.primaryTag') : ''),
    desc: statusInfo(a.status).label,
    dot: 'st-' + (statusInfo(a.status).cls === 'busy' ? 'busy' : statusInfo(a.status).cls === 'input' ? 'input' : 'idle'),
    value: { kind: 'sess', a }, picked: true,
  }));
  items.push({ label: t('pulse.closeAllRunCloseDay'), desc: t('pulse.closeAllRunCloseDayHint'), icon: 'moon', value: { kind: 'closeday' }, picked: false });
  items.push({ label: t('pulse.closeAllKill'), desc: t('pulse.closeAllKillHint'), icon: 'trash', value: { kind: 'kill' }, picked: false });
  const chosen = await checkModal(t('pulse.closeAllTitle'), items, {
    hint: t('pulse.closeAllSub'), placeholder: t('modal.filterPlaceholder'), confirmLabel: t('pulse.closeAllConfirm'),
  });
  if (!chosen) return;
  const picked = chosen.filter((c) => c.kind === 'sess').map((c) => c.a);
  if (!picked.length) { toast(t('pulse.closeAllNoneSelected')); return; }
  const doCloseDay = chosen.some((c) => c.kind === 'closeday');
  const doKill = chosen.some((c) => c.kind === 'kill');
  // 1. broadcast the non-interactive capture — each session wraps ITSELF up (race-safe)
  for (const a of picked) {
    const hit = byName(a.name);
    if (hit && !panes.get(hit[0]).exited) submitToPty(hit[0], '/aios:close-session --auto');
    else if (a.pid) void window.glassShell.sessionSignal(a.pid, 'SIGTERM');
  }
  toast(t('pulse.closeAllSent', { n: picked.length, primary }));
  // 2. optional kill — ONLY after a session finishes capturing, and never the primary
  if (doKill) {
    const killNames = picked.filter((a) => a.name !== primary).map((a) => a.name);
    void watchThenKill(killNames);
  }
  // 3. optional consolidation — one writer, in the primary session
  if (doCloseDay) setTimeout(() => void runInPrimary('/aios:close-day'), 1500);
}

/* Wait for each named session to finish its --auto capture (seen busy → back to
   idle, or gone from the registry), THEN kill it. Never kills mid-capture; a session
   that never shows the cycle inside the window is left alone (safer than losing work). */
async function watchThenKill(names) {
  const pending = new Set(names), seenBusy = new Set();
  const deadline = Date.now() + 180000;
  await new Promise((r) => setTimeout(r, 2500)); // grace: let close-session start
  while (pending.size && Date.now() < deadline) {
    const live = new Map((((pulse.lastRunning || {}).running) || []).map((a) => [a.name, a]));
    for (const n of [...pending]) {
      const a = live.get(n);
      if (a && statusInfo(a.status).cls === 'busy') { seenBusy.add(n); continue; }
      const gone = !a;
      if (!gone && !seenBusy.has(n)) continue;
      pending.delete(n);
      const hit = byName(n);
      if (hit) closePane(hit[0]);
      else if (a && a.pid) void window.glassShell.sessionSignal(a.pid, 'SIGTERM');
    }
    if (pending.size) await new Promise((r) => setTimeout(r, 1500));
  }
  if (pending.size) toast(t('pulse.closeAllKillTimeout', { names: [...pending].join(', ') }));
}

/* a boxed, collapsible sub-section (Glass's Sessions / Terminals headers) */
function runSection(parent, label, key, count, onAdd, addTitle, fill, extra) {
  const collapsed = pulse.runCollapsed.has(key);
  const row = el('div', 'psubrow');
  const head = el('button', 'psub' + (collapsed ? ' col' : ''));
  head.appendChild(el('span', 'psubcaret', collapsed ? '▸' : '▾'));
  head.appendChild(el('span', 'psublab', label));
  if (count) head.appendChild(el('span', 'psubcount', String(count)));
  head.addEventListener('click', () => {
    if (pulse.runCollapsed.has(key)) pulse.runCollapsed.delete(key); else pulse.runCollapsed.add(key);
    try { localStorage.setItem('runCollapsed', JSON.stringify([...pulse.runCollapsed])); } catch { /* ignore */ }
    paintRunning();
  });
  const add = el('button', 'psubadd'); add.innerHTML = icon('plus', 13); add.title = addTitle;
  add.addEventListener('click', (e) => { e.stopPropagation(); onAdd(); });
  row.appendChild(head);
  if (extra) { // e.g. "close all sessions" — only offered while sessions run
    const xb = el('button', 'psubadd'); xb.innerHTML = icon(extra.icon, 13); xb.title = extra.title;
    xb.addEventListener('click', (e) => { e.stopPropagation(); extra.onClick(); });
    row.appendChild(xb);
  }
  row.appendChild(add);
  parent.appendChild(row);
  if (!collapsed) { const box = el('div', 'psubbox'); fill(box); parent.appendChild(box); }
}

function buildQuotaRow(q) {
  const row = el('div', 'qrow');
  const bar = el('div', 'qbar');
  const f = Math.round(q.fiveHour || 0), s7 = Math.round(q.sevenDay || 0);
  const fill = el('div', 'qfill ' + ((f >= 95 || s7 >= 99) ? 'red' : f >= 90 ? 'orange' : f >= 85 ? 'yellow' : ''));
  fill.style.width = Math.min(100, f) + '%';
  bar.appendChild(fill);
  row.appendChild(bar);
  const fmtIn = (sec) => {
    if (!sec) return '';
    const mm = Math.max(0, Math.round((sec * 1000 - Date.now()) / 60000));
    if (mm < 60) return mm + 'm';
    const h = Math.floor(mm / 60);
    return h < 24 ? h + 'h' + (mm % 60 ? ' ' + (mm % 60) + 'm' : '') : Math.floor(h / 24) + 'd';
  };
  const reset = (f >= 85 && fmtIn(q.fr)) ? t('pulse.resetsIn', { time: fmtIn(q.fr) }) : '';
  row.appendChild(el('span', 'qlabel', '5h ' + f + '% (7d ' + s7 + '%)' + reset));
  return row;
}
function sessionRow(a) {
  const r = el('div', 'prow2'); r.tabIndex = 0;
  const s = statusInfo(a.status);
  const dot = el('span', 'pdot ' + s.cls); dot.title = s.title;
  r.appendChild(dot);
  r.appendChild(el('span', 'rname', a.name));
  const stt = theater.get(a.name) || { busySince: 0, lastDur: 0 };
  const ownPane = (() => { const hit = byName(a.name); return hit && !panes.get(hit[0]).exited ? { id: hit[0], p: panes.get(hit[0]) } : null; })();
  if (s.cls === 'busy') {
    // live-run theater: shimmer verb + honest elapsed; pty ticker when we own the stream
    const pst = el('span', 'pst');
    pst.appendChild(el('span', 'shimverb', t('theater.working')));
    const since = stt.busySince || a.updatedAt;
    const elapsed = since ? fmtAgo(since) : '';
    if (elapsed && elapsed !== 'now') pst.appendChild(document.createTextNode(' ' + t('theater.for', { time: elapsed })));
    r.appendChild(pst);
    if (ownPane && ownPane.p.lastLine) { pst.classList.add('tight'); r.appendChild(buildTicker('term-' + ownPane.id, ownPane.p.lastLine)); }
    else if (a.proj) pst.appendChild(document.createTextNode(' · ' + a.proj));
  } else {
    // idle collapse: "Worked for 12m" when we watched a run end, else the plain status
    const dur = fmtAgo(a.updatedAt);
    const label = (s.cls === 'idle' && stt.lastDur) ? t('theater.workedFor', { time: fmtDur(stt.lastDur) }) : s.label + (dur ? ' ' + dur : '');
    r.appendChild(el('span', 'pst', '· ' + label + (a.proj ? ' · ' + a.proj : '')));
  }
  const mem = fmtMem(a.mem);
  if (mem) r.appendChild(el('span', 'rmem', mem));
  // open: reveal the in-window pane, OR resume the session INTO the app (so external sessions actually load)
  const open = () => {
    const hit = byName(a.name);
    if (hit && !panes.get(hit[0]).exited) { setActive(hit[0]); return; }
    const cmd = a.id ? `${CLAUDE} --resume ${shq(a.id)}` : `${CLAUDE} --resume`;
    void createPane({ name: a.name, cmd });
    toast(t('session.resuming', { name: a.name }));
  };
  const acts = el('span', 'runacts');
  const actBtn = (ic, title, cls, fn) => {
    const b = el('button', 'runact' + (cls ? ' ' + cls : '')); b.innerHTML = icon(ic, 12); b.title = title;
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    acts.appendChild(b);
    return b;
  };
  // Interrupt: ESC into the in-window pane if we own it, else SIGINT by pid
  // #12/#19 session post-its — the note button PERSISTS with a count badge when this
  // session has notes (so a reminder is visible without hovering); hover-only otherwise.
  const nCount = (pulse.noteCounts || {})[a.name] || 0;
  const nb = actBtn('note', t('session.notes'), 'note' + (nCount ? ' has' : ''), () => void openSessionNotes(a.name));
  if (nCount && nb) { const bdg = el('span', 'notebadge', String(nCount)); nb.appendChild(bdg); }
  if (s.cls === 'busy') actBtn('stop', t('session.interrupt'), '', () => {
    const hit = byName(a.name);
    if (hit) window.glassShell.ptyWrite(hit[0], '\x1b');
    else if (a.pid) { void window.glassShell.sessionSignal(a.pid, 'SIGINT'); toast(t('session.interrupted', { name: a.name })); }
  });
  // Close session: type /close-session if in-window, else graceful SIGTERM
  actBtn('logout', t('session.close'), '', () => {
    const hit = byName(a.name);
    if (hit) { submitToPty(hit[0], '/aios:close-session'); setActive(hit[0]); }
    else if (a.pid) { void window.glassShell.sessionSignal(a.pid, 'SIGTERM'); toast(t('session.closing', { name: a.name })); }
  });
  // Kill: behavior is configurable (Glass killBehavior parity) — ask (confirm
  // capture/kill), kill (immediate SIGKILL), capture (/close-session first, keep
  // the work). Kill is destructive + irreversible, so the default is ask.
  actBtn('trash', t('session.kill'), 'kill', async () => {
    const hardKill = () => {
      const hit = byName(a.name);
      if (a.pid) void window.glassShell.sessionSignal(a.pid, 'SIGKILL');
      if (hit) closePane(hit[0]);
      toast(t('session.killed', { name: a.name }));
    };
    const capture = () => {
      const hit = byName(a.name);
      if (hit) { submitToPty(hit[0], '/aios:close-session'); setActive(hit[0]); }
      else if (a.pid) void window.glassShell.sessionSignal(a.pid, 'SIGTERM');
      toast(t('session.closing', { name: a.name }));
    };
    if (KILLBEHAVIOR === 'kill') { hardKill(); return; }
    if (KILLBEHAVIOR === 'capture') { capture(); return; }
    // #20: the same searchable/selectable list UX as the frequent-tasks picker —
    // with a sentence explaining what each option actually does.
    const choice = await listModal(t('session.killConfirmTitle', { name: a.name }), [
      { label: t('session.killCapture'), desc: t('session.killCaptureHint'), icon: 'logout', value: 'capture' },
      { label: t('session.killNow'), desc: t('session.killNowHint'), icon: 'trash', value: 'kill' },
    ], t('session.killPlaceholder'));
    if (choice === 'capture') capture();
    else if (choice === 'kill') hardKill();
  });
  r.appendChild(acts);
  r.addEventListener('click', open);
  r.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
  return r;
}
function terminalRow(tid, p) {
  const r = el('div', 'prow2'); r.tabIndex = 0;
  r.appendChild(el('span', 'pdot' + (p.exited ? '' : ' idle')));
  r.appendChild(el('span', 'rname', p.name || t('pulse.terminal')));
  if (p.exited) r.appendChild(el('span', 'pst', t('pulse.ended')));
  else if (p.lastLine) r.appendChild(buildTicker('term-' + tid, p.lastLine)); // pty-grade: live output tail
  const acts = el('span', 'runacts');
  const close = el('button', 'runact kill'); close.innerHTML = icon('trash', 12); close.title = t('pulse.closeTerminal');
  close.addEventListener('click', (e) => { e.stopPropagation(); closePane(tid); });
  acts.appendChild(close);
  r.appendChild(acts);
  r.addEventListener('click', () => setActive(tid));
  return r;
}

function renderPulseMonth(d) {
  pulse.calCur = { year: d.year, month: d.month };
  pulse.lastMonth = d;
  paintCalendar();
}
function paintCalendar() {
  const d = pulse.lastMonth;
  if (!d) return;
  const C = document.getElementById('pCal');
  C.replaceChildren();
  C.appendChild(pulseTitle(C, 'pCal', t('pulse.calendar')));
  const head = el('div', 'pcalhead');
  const prev = el('button', 'pnav', '‹');
  const lab = el('span', 'plabel', d.label);
  const next = el('button', 'pnav', '›');
  const toggle = el('button', 'pcaltoggle', pulse.calView === 'week' ? t('pulse.calMonth') : t('pulse.calWeek'));
  toggle.title = t('pulse.calToggle');
  prev.addEventListener('click', () => nav(-1));
  next.addEventListener('click', () => nav(1));
  toggle.addEventListener('click', () => {
    pulse.calView = pulse.calView === 'week' ? 'month' : 'week';
    if (pulse.calView === 'week') { pulse.weekIdx = -1; pulse.pendingWeek = null; } // -1 → today's week
    try { localStorage.setItem('calView', pulse.calView); } catch { /* ignore */ }
    paintCalendar();
  });
  // month nav, or week nav (cross-month picks the adjacent edge week)
  function nav(dd) {
    if (pulse.calView === 'week') {
      const total = d.weeks.length;
      const nextI = (pulse.weekIdx < 0 ? d.weeks.findIndex((w) => w.some((c) => c.isToday)) : pulse.weekIdx) + dd;
      if (nextI >= 0 && nextI < total) { pulse.weekIdx = nextI; paintCalendar(); return; }
      pulse.pendingWeek = dd > 0 ? 'first' : 'last';
    }
    let m2 = d.month + dd, y2 = d.year;
    if (m2 < 1) { m2 = 12; y2--; }
    if (m2 > 12) { m2 = 1; y2++; }
    pulse.send({ type: 'navMonth', year: y2, month: m2 });
  }
  head.append(prev, lab, next, toggle);
  C.appendChild(head);
  let weeks = d.weeks;
  let weekNums = d.weekNums || [];
  if (pulse.calView === 'week') {
    if (pulse.pendingWeek === 'last') pulse.weekIdx = weeks.length - 1;
    else if (pulse.pendingWeek === 'first') pulse.weekIdx = 0;
    else if (pulse.weekIdx < 0) { const ti = weeks.findIndex((w) => w.some((c) => c.isToday)); pulse.weekIdx = ti >= 0 ? ti : 0; }
    pulse.pendingWeek = null;
    pulse.weekIdx = Math.max(0, Math.min(pulse.weekIdx, weeks.length - 1));
    weeks = [weeks[pulse.weekIdx]];
    weekNums = [weekNums[pulse.weekIdx]];
  }
  const table = document.createElement('table');
  const thr = document.createElement('tr');
  if (SHOWWK) { const wh = document.createElement('th'); wh.className = 'wkh'; wh.title = t('pulse.weekCol'); thr.appendChild(wh); } // blank header over the week column
  for (const w of d.weekdays) { const th = document.createElement('th'); th.textContent = w[0]; thr.appendChild(th); }
  const thead = document.createElement('thead'); thead.appendChild(thr); table.appendChild(thead);
  const tbody = document.createElement('tbody');
  for (const [wi, week] of weeks.entries()) {
    const tr = document.createElement('tr');
    if (SHOWWK) { const wn = document.createElement('td'); wn.className = 'wknum'; wn.textContent = weekNums[wi] ? 'W' + weekNums[wi] : ''; tr.appendChild(wn); }
    for (const c of week) {
      const td = document.createElement('td');
      if (c.day !== null) {
        const cell = el('div', 'pcell' + (c.hasNote ? ' has' : '') + (c.isToday ? ' today' : ''), String(c.day));
        if (c.hasNote || c.isToday) cell.addEventListener('click', () => pulse.send({ type: 'openDay', date: c.date }));
        td.appendChild(cell);
      }
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  C.appendChild(table);
}

function renderPulseUpdate(m) {
  updateRailStatus(m.state, m.framework || null);
  // the framework-update row of the "Needs you" inbox (null while dismissed)
  if ('inboxUpdate' in m) { pulse.lastInboxUpdate = m.inboxUpdate || null; renderInboxCard(); }
  // The framework status lives ONLY in the panel header now (updateRailStatus above) —
  // the old footer badge duplicated it at the bottom of the panel.
}

/* ── unified/split zones: tabs + panes per zone ───────────────────────────── */
const panes = new Map(); // id → { kind, name, el, tab, term?, fit?, exited?, path? }
const active = { main: null, term: null };
let viewSeq = 0;

const zoneOf = (p) => (split && p.kind === 'term' ? 'term' : 'main');
const tabsEl = (z) => document.getElementById(z === 'term' ? 'ttabs' : 'tabs');
const panesEl = (z) => document.getElementById(z === 'term' ? 'tpanes' : 'panes');

/* `fresh` marks a pane the operator JUST opened, and only those trigger revealZone.
   Learned the hard way: revealZone was hooked in here unconditionally, on the belief that
   homePane is "where a new pane lands". It is not — applySplit() re-homes EVERY pane on every
   layout change, so the reveal fired during layout operations too. The result was that expanding
   a zone set th to 0.93, applySplit re-homed a main-zone pane, revealZone saw main squeezed and
   snapped straight back to 0.38: the expand button did nothing at all, from any starting point,
   and it also set up a revealZone → applySplit → homePane → revealZone loop that only terminated
   because the second pass was no longer squeezed.
   ensureTermRoom already had this right by being called once from the creation path. Same rule
   here: a side effect that means "the operator asked for this" must be driven by the operator's
   action, never by a repaint. */
function homePane(id, p, { fresh = false } = {}) {
  const z = zoneOf(p);
  // label · tabs · (+) … expand — the (+) travels with the tabs, expand pins right
  registerTab(id, z);
  paintStrip(z);
  panesEl(z).appendChild(p.el);
  setVisible(z);
  updateEmpty();
  /* A pane landing in a HIDDEN zone must un-hide it, or the operator opens something and
     nothing appears. This was terminal-only because only the dock could hide; now that the
     editor zone hides on the same rule, both directions need it. */
  const zoneEl = document.getElementById(z === 'term' ? 'termzone' : 'viewzone');
  if (split && zoneEl && zoneEl.style.display === 'none') applySplit();
  if (fresh) revealZone(z);
}

/* The welcome state belongs to an EMPTY WINDOW, not to an empty editor zone. Keying it off
   the main zone alone is what put the AIOS logo on top of an expanded terminal: no editor
   pane meant "show the welcome" even when the operator was clearly working in a terminal. */
function updateEmpty() {
  const anyPane = panes.size > 0;
  const e = document.getElementById('empty');
  if (e) e.style.display = anyPane ? 'none' : 'flex';
}

/* ═══ ⌘-CLICK A PATH IN A TERMINAL → OPEN IT IN THE EDITOR ═══════════════════
   Asked for by an operator: "cuando nombra un archivo, poder hacer command + click para
   abrirlo en el editor."

   The first cut gated the whole provider on ⌘ being held, so nothing underlined until you
   MOVED the mouse — xterm only re-queries a link provider on mouse movement, so pressing ⌘
   over a stationary cursor did nothing at all. It read as lag; it was a missing trigger.

   Now: hovering ALWAYS underlines and shows "⌘-click to open". That removes the trigger
   problem, and it removes the reason the gate existed — an underline that a plain click
   ignores is only confusing if nothing explains it. The tooltip explains it.

   A candidate becomes a link only if it RESOLVES to a real file inside the allowed roots.
   Terminal output is dense with path-shaped text (URLs, package names, `a/b` in diffs), so the
   existence check is what stops half the screen underlining — and it doubles as containment.
   Resolution is ONE batched IPC per line, memoised per line-text: the per-candidate round trip
   was the actual latency. */
/* Two patterns, tried in order, because a space is genuinely ambiguous in terminal output —
   it separates arguments as often as it sits inside a filename, and no regex can tell which.
   So spaces are only honoured where the text itself DELIMITS them: inside quotes or backticks.
   That covers the cases that actually occur — `git status` quotes paths containing spaces, and
   this vault is full of them ("00 - notes/...") — without turning every sentence into a
   candidate link. Unquoted paths keep the conservative rule. */
const PATH_QUOTED_RE = /["'`]([^"'`\n]{2,200}?\.[A-Za-z]{1,8}(?::\d+)?)["'`]|["'`]([^"'`\n]{2,200}?\/[^"'`\n]{1,200}?)["'`]/g;
const PATH_RE = /(?:~|\.{1,2})?\/?[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)+(?::\d+)?|\b[A-Za-z0-9._@+-]+\.[A-Za-z]{1,8}(?::\d+)?/g;

/** Candidates on one line. Quoted matches first (their quotes delimit any spaces), then bare
    tokens — and each bare token also gets EXTENDED across the spaces that follow it.

    A space is ambiguous in terminal output: it separates arguments as often as it sits inside a
    filename, and no regex can tell which. But we already validate every candidate against the
    filesystem, so the ambiguity does not have to be solved by pattern — it can be RESOLVED BY
    FACT. `…/vault/00` extended by `-` and then `notes/context/observed/antifragile.md` becomes a
    path that exists, and existence is the answer. The longest candidate that resolves wins, so a
    real filename beats its own truncated prefix. */
function pathCandidates(text) {
  const out = [];
  for (const m of text.matchAll(PATH_QUOTED_RE)) {
    const val = m[1] ?? m[2];
    if (!val) continue;
    out.push({ value: val, index: m.index + 1, length: val.length, alts: [] });
  }
  const covered = (i) => out.some((o) => i >= o.index - 1 && i < o.index + o.length + 1);
  const MAX_SPAN = 6;   // tokens a filename may plausibly span; bounds the candidate count
  for (const m of text.matchAll(PATH_RE)) {
    if (covered(m.index)) continue;
    /* Extend across REAL tokens only. A buffer row is padded to the terminal width, so a
       naive split(' ') yields a tail of empty strings and the extension budget gets spent
       generating `"…/03 - "`, `"…/03 -  "`, `"…/03 -   "` — six candidates that differ only by
       trailing whitespace, none of which can exist, while a genuine continuation further along
       never gets tried. Observed in the provider's own log. */
    const rest = text.slice(m.index).replace(/\s+$/, '');
    const toks = rest.split(' ').filter((tk) => tk.length > 0);
    const alts = [];
    let acc = toks[0] ?? m[0];
    for (let i = 1; i < Math.min(toks.length, MAX_SPAN); i++) {
      acc += ' ' + toks[i];
      const trimmed = acc.replace(/[)\]},.;:'"]+$/, '');
      if (trimmed.length > m[0].length) alts.push(trimmed);
      /* Keep the UNTRIMMED form too. Stripping trailing punctuation is right for prose
         (`see /tmp/a.md.`) and wrong when a line BREAKS just after a dot: `…-notas.` ⏎ `html`
         loses the dot, so the candidate stops one char short of the line end, loses eligibility
         for the join to the relative echo of itself, and the absolute path is never offered.
         Both forms cost one stat each and the filesystem decides which is real. */
      if (acc.length > m[0].length && acc !== trimmed) alts.push(acc);
    }
    out.push({ value: m[0], index: m.index, length: m[0].length, alts });
  }
  return out.slice(0, 16);
}

/* Reassemble a path broken by a HARD newline. Kept a NAMED function, not inline in the link
   provider, because that is exactly where the last defect hid: two features that were each
   correct alone, composed wrong, with no test able to reach the seam.

   Joining looks reckless — glue any two lines together and you could link across unrelated
   prose — but the same guarantee that makes space-extension safe applies: nothing becomes a
   link unless it RESOLVES TO A REAL FILE, so a false positive would have to be an actual path.
   Only the LAST candidate is eligible (a break can only happen at the end of a line), and both
   joins are offered — with and without a space — because the newline may or may not have
   replaced one. The filesystem picks. */
function joinAcrossBreak(hits, next, nextRow) {
  /* Which candidate is eligible? NOT `hits[hits.length - 1]`. A path with spaces produces a
     second, relative-looking match for its own tail (`…/03 - export/deck.html` also yields
     `export/deck.html`), so the array tail can start MID-path. Joining that one would offer
     `export/…/gifts/espacios-…` — resolvable only by accident against the cwd — while the
     absolute form never gets tried. The candidate that matters is the one whose furthest
     extension REACHES THE END of the line, since that is where a break can occur. Ties go to
     the earlier start, i.e. the longer, more-qualified form. */
  const list = hits || [];
  const extent = (h) => h.index + h.alts.reduce((n, a2) => Math.max(n, a2.length), h.length);
  const lineEnd = list.reduce((n, h) => Math.max(n, extent(h)), -1);
  /* EVERY candidate reaching that end, not the single best. Picking one needs a tie-break, and
     the tie is common: space-extension lets an earlier path also stretch to the line end, so
     `see /tmp/a.md and /Users/…/03 - ` has two candidates ending together and the wrong winner
     means the real path never joins at all. There is no cost to offering both — the filesystem
     is the gate, and a candidate that cannot exist simply fails to resolve. */
  const eligible = next ? list.filter((h) => extent(h) === lineEnd) : [];
  for (const tail of eligible) {
  /* EVERY form the tail can take, not just the bare regex match. The match stops at the first
     space, so when the break falls after a space-containing segment (`…/vault/03 - ` ⏎
     `export/…`) the correct string is an EXTENSION plus the next line. Joining only the bare
     match drops the ` - ` and offers two strings that cannot exist — which is precisely why one
     path refused to link while every other two-line case worked. The spread snapshots the
     array, so pushing into it inside the loop is safe. */
    tail.joined = new Set();
    for (const head of [tail.value, ...tail.alts]) {
      for (const j of [head + ' ' + next, head + next]) {
        if (tail.joined.has(j)) continue;
        tail.joined.add(j);
        tail.alts.push(j);
      }
    }
    tail.spansTo = { row: nextRow, len: next.length };
  }
  return eligible;
}

const NO_WEBGL = !!(window.glassShell.env && window.glassShell.env.AIOS_NO_WEBGL);
const LINK_DEBUG = false;  // flip on to have the provider narrate what it sees
const linkCache = new Map();   // `${cwd}\n${lineText}` → { token: absPath }

let pathTip = null;
function showPathTip(x, y, text) {
  if (!pathTip) { pathTip = el('div', 'pathtip'); document.body.appendChild(pathTip); }
  pathTip.textContent = text;
  pathTip.hidden = false;
  const w = pathTip.offsetWidth || 220;
  pathTip.style.left = Math.max(8, Math.min(x + 12, window.innerWidth - w - 8)) + 'px';
  pathTip.style.top = Math.max(8, y - 34) + 'px';
}
function hidePathTip() { if (pathTip) pathTip.hidden = true; }

/* A WRAPPED path is still one path. provideLinks() is handed a single buffer ROW, but xterm
   wraps a long line across several — so a path longer than the terminal is width-split and the
   fragment never resolves. Measured: paths up to 76 chars linked, 96+ did not, and it had
   nothing to do with the spaces I had assumed. Rebuild the logical line from its wrapped rows,
   then map match offsets back to (row, column) so the link still highlights in the right place.
   `isWrapped` on a row means "I am a continuation of the row above". */
function logicalLine(term, y) {
  const buf = term.buffer.active;
  let start = y - 1;
  while (start > 0 && buf.getLine(start) && buf.getLine(start).isWrapped) start--;
  const rows = [];
  for (let i = start; buf.getLine(i) && (i === start || buf.getLine(i).isWrapped); i++) rows.push(i);
  // translateToString(false): keep the padding, or the column arithmetic below drifts.
  const text = rows.map((r) => buf.getLine(r).translateToString(false)).join('');
  const after = buf.getLine(rows[rows.length - 1] + 1);
  return {
    text, startRow: start, cols: term.cols,
    nextRow: rows[rows.length - 1] + 1,
    // The continuation of a HARD-wrapped path: text the printer broke itself, usually indented.
    next: after ? after.translateToString(true).replace(/^\s+/, '') : '',
  };
}

function attachPathLinks(term, cwd) {
  term.registerLinkProvider({
    provideLinks(y, cb) {
      const line = term.buffer.active.getLine(y - 1);
      if (!line) { cb(undefined); return; }
      const L = logicalLine(term, y);
      const text = L.text;
      // absolute offset in the logical line -> the cell it actually occupies on screen
      const at = (i) => ({ x: (i % L.cols) + 1, y: L.startRow + Math.floor(i / L.cols) + 1 });
      const hits = pathCandidates(text);
      /* A path can be broken by a HARD newline, not just by the terminal: a session printing
         markdown wraps its own output and indents the continuation, so `…/vault/03 -` ends one
         line and `export/…/notes.html` begins the next with `isWrapped` false. Reassembling that
         looks reckless — join any two lines and you could link across unrelated prose — but the
         same guarantee that makes space-extension safe applies here: nothing becomes a link
         unless it RESOLVES TO A REAL FILE. A false positive would have to be an actual path.
         Only the LAST candidate on a line is eligible (a break can only happen at the end), and
         both joins are offered — with and without a space — because the newline may or may not
         have replaced one. The filesystem picks. */
      joinAcrossBreak(hits, L.next, L.nextRow);
      /* TEMPORARY (AI-64 follow-up): one path refuses to link and the screenshot contradicts
         the wrap theory — a 105-char line sits unwrapped while a 57-char break appears above.
         Log what the provider actually sees rather than reason about it again. */
      if (LINK_DEBUG && /espacios|03 -/.test(text)) {
        console.log('[link] cols=' + L.cols + ' startRow=' + L.startRow + ' rows=' + Math.ceil(text.length / L.cols));
        console.log('[link] logical=' + JSON.stringify(text.replace(/\s+$/, '')));
        console.log('[link] candidates=' + JSON.stringify(hits.map((h) => [h.value, ...h.alts])));
      }
      if (!hits.length) { cb(undefined); return; }
      const key = (cwd || '') + '\n' + text;   // logical line, so wrapped rows share one entry
      const build = (map) => {
        const links = [];
        for (const m of hits) {
          /* Longest wins: a filename containing spaces must beat the shorter prefix that also
             happens to exist (a directory, usually). Shortest-match would link the folder. */
          let best = null;
          for (const cand of [...m.alts].sort((a2, b2) => b2.length - a2.length)) {
            if (map[cand]) { best = { text: cand, abs: map[cand] }; break; }
          }
          if (!best && map[m.value]) best = { text: m.value, abs: map[m.value] };
          if (!best) continue;
          const abs = best.abs;
          links.push({
            /* A joined candidate ends on the NEXT row, so its range must too — xterm ranges
               may span rows, and clamping to this one would underline only half the path. */
            range: (m.spansTo && m.joined && m.joined.has(best.text))
              ? { start: at(m.index), end: { x: Math.max(1, m.spansTo.len), y: m.spansTo.row + 1 } }
              : { start: at(m.index), end: at(m.index + best.text.length - 1) },
            text: best.text,
            decorations: { pointerCursor: true, underline: true },
            hover: (ev) => showPathTip(ev.clientX, ev.clientY, abs + '  ·  ' + t('term.cmdClickOpen')),
            leave: () => hidePathTip(),
            activate: (ev) => {
              hidePathTip();
              // ⌘/Ctrl required, as asked. A plain click falls through to the terminal, so
              // selecting text over a path still behaves like a terminal.
              if (!ev.metaKey && !ev.ctrlKey) return;
              void openViewer(abs);
            },
          });
        }
        cb(links.length ? links : undefined);
      };
      const cached = linkCache.get(key);
      if (cached) { build(cached); return; }
      window.glassShell.resolveFiles(hits.flatMap((m) => [m.value, ...m.alts]), cwd).then((map) => {
        if (linkCache.size > 400) linkCache.clear();   // bounded; the buffer scrolls forever
        if (LINK_DEBUG && /espacios|03 -/.test(text)) console.log('[link] resolved=' + JSON.stringify(map));
        linkCache.set(key, map || {});
        build(map || {});
      }).catch(() => cb(undefined));
    },
  });
}

/* ═══ TAB ORDER — a MODEL, not a DOM artifact ════════════════════════════════
   applySplit() re-homes every pane on every layout change, and homePane() re-inserts each
   tab with insertBefore — which MOVES an existing node. So the strip's order was always a
   replay of `panes` Map iteration order, and a Map cannot be reordered in place. Any drag
   that only rearranged the DOM would look correct and then snap back on the next expand,
   split toggle or theme change.

   So order lives here, per zone, as the single source the strip is painted from. A pane can
   change zones (a terminal moves between 'main' and 'term' when split toggles), so
   registerTab keeps it in exactly one list. */
const tabOrder = { main: [], term: [] };

function registerTab(id, z) {
  const other = z === 'main' ? 'term' : 'main';
  const oi = tabOrder[other].indexOf(id);
  if (oi >= 0) tabOrder[other].splice(oi, 1);
  if (!tabOrder[z].includes(id)) tabOrder[z].push(id);
}

function unregisterTab(id) {
  for (const z of ['main', 'term']) {
    const i = tabOrder[z].indexOf(id);
    if (i >= 0) tabOrder[z].splice(i, 1);
  }
}

/* Paint the strip from the order model. Called after any re-home, which is what makes a
   manual order survive the layout churn that used to erase it. */
function paintStrip(z) {
  const strip = tabsEl(z);
  if (!strip) return;
  const plus = strip.querySelector('.newTab');
  for (const id of tabOrder[z]) {
    const p = panes.get(id);
    if (p && p.tab) strip.insertBefore(p.tab, plus);
  }
}

/* Move `dragId` to just before/after `overId` inside one strip. Same-strip only by design:
   a tab cannot cross zones, land in the explorer, or enter the panel. */
function moveTab(z, dragId, overId, after) {
  const list = tabOrder[z];
  const from = list.indexOf(dragId);
  if (from < 0) return;
  list.splice(from, 1);
  let to = list.indexOf(overId);
  if (to < 0) { list.push(dragId); } else { list.splice(after ? to + 1 : to, 0, dragId); }
  paintStrip(z);
}

/* AI-69 — A TERMINAL COMING BACK INTO VIEW MUST BE REPAINTED, and fit() cannot do it.
   Switching panes showed garbled glyphs until you typed. `setActive()` calls `fit()`, but
   **fit() is a no-op when the size has not changed** — which is precisely the pane-to-pane
   switch — so nothing forced a redraw and the canvas kept whatever was last rasterised into
   it. Corroborated from outside: the same artifact appears in other xterm hosts, where
   RESIZING the window clears it — a resize changes dimensions, so it forces the repaint a
   plain switch never asks for. `refresh()` does not depend on a size change, so it does. */
function repaintTerm(p) {
  if (!p || p.kind !== 'term' || !p.term) return;
  try { p.term.refresh(0, p.term.rows - 1); } catch { /* disposed mid-switch */ }
}

/* A TERMINAL IS NEVER HIDDEN WITH `display:none`. That gives its container a ZERO-SIZE box,
   and xterm's WebGL renderer bails on exactly that — `_refreshCharAtlas()` opens with
   `if (char.width <= 0 && char.height <= 0) return void(this._isAttached = false)`. A session
   that keeps PRINTING while you are on another tab therefore writes into a detached renderer,
   and the canvas you come back to holds garbage until enough churn rebuilds it (typing). That
   is why the artifact only appeared on terminals that were WORKING — an idle one has nothing
   to mis-render while hidden.
   `visibility` hides it without taking the box away, so the renderer stays attached and keeps
   painting correctly the whole time. This costs nothing structurally: `.pane` is already
   `position:absolute; inset:…`, so panes stack in one box rather than flowing — and a
   visibility-hidden element takes no pointer events, so the visible pane still gets the clicks.
   The trade is real and deliberate: hidden terminals keep rendering. For a handful of panes
   that is cheaper than a class of corruption the operator has to type to clear.
   VIEWERS keep using `display`: they have no renderer to detach, and leaving them out of
   layout is free. */
const PANE_HIDDEN = 'panehidden';

function setPaneShown(p, on) {
  if (p.kind === 'term') {
    p.el.style.display = 'flex';          // always laid out; see the note above
    p.el.classList.toggle(PANE_HIDDEN, !on);
  } else {
    p.el.style.display = on ? 'flex' : 'none';
    p.el.classList.remove(PANE_HIDDEN);
  }
}

/** On screen right now — must consult BOTH mechanisms, or terminals read as always-visible. */
function paneShown(p) {
  return !!p && !!p.el && p.el.style.display !== 'none' && !p.el.classList.contains(PANE_HIDDEN);
}

/** Every live terminal, visible or not. Hidden ones keep their box and stay attached, so they
    can — and must — repaint when a SHARED resource changes underneath them. */
function liveTerms() {
  const out = [];
  for (const q of panes.values()) if (q.kind === 'term' && q.term && !q.exited) out.push(q);
  return out;
}

function setVisible(z) {
  const act = active[z];
  for (const [pid, p] of panes) {
    if (zoneOf(p) !== z) continue;
    const on = pid === act;
    const wasHidden = !paneShown(p);
    setPaneShown(p, on);
    p.tab.classList.toggle('active', on);
    // Repaint on the hidden → visible transition only; repainting an already-visible pane
    // on every call would burn a frame on each tab click for nothing.
    if (on && wasHidden) repaintTerm(p);
  }
}

function setActive(id) {
  const p = panes.get(id);
  if (!p) return;
  const z = zoneOf(p);
  active[z] = id;
  setVisible(z);
  // keep the active tab reachable when the strip has scrolled past the window
  try { p.tab.scrollIntoView({ inline: 'nearest', block: 'nearest' }); } catch { /* older engines */ }
  if (p.kind === 'term') { p.fit.fit(); p.term.focus(); }
  // auto-reveal: the explorer follows the active file tab (skips synthetic ::tabs)
  if (p.kind === 'view' && p.path && EXPLORER.autoReveal && !String(p.path).startsWith('::')) void revealPath(p.path);
  /* COMING BACK TO SETUP RE-VERIFIES IT. The re-verify that is supposed to follow a setup command
     hooks the pane's EXIT — and these panes do not exit: the script finishes, prints its verdict,
     and the shell stays open at a prompt. So the only thing advancing the stepper is a 5s poll,
     which is itself paused whenever the window is not visible. An operator who installs, watches
     the terminal, switches away, and clicks back to Setup can land on a screen that has not
     re-checked since before the install — the step they just completed still glaring at them.
     Returning to the tab is exactly the moment they are asking "did that work?", so answer it. */
  if (p.path === '::setup' && typeof onboardingRepaint === 'function') void onboardingRepaint();
}

function ensureActive(z) {
  const ids = [...panes.entries()].filter(([, p]) => zoneOf(p) === z).map(([id]) => id);
  if (!ids.includes(active[z])) active[z] = ids[ids.length - 1] ?? null;
  setVisible(z);
}

/* ═══ APP UPDATE PILL ═══════════════════════════════════════════════════════
   The mechanism has always worked (download + install-on-quit + a native OS notification);
   what was missing was any in-app way to KNOW. updater.ts emitted on `shell:updater` and
   nothing listened.

   It appears on `ready` ONLY — never on `available`. While a download is in flight there is
   nothing the operator can do, and a pill that invites a click it cannot honour is worse than
   no pill. By the time it shows, the bytes are on disk and the only remaining act is a restart.

   The text names the ACTION, not the state. "Update available" reports a fact and leaves the
   reader to work out their move; "Restart to update" IS the move, and it is honest about the
   cost — which matters here because a restart currently closes every terminal. */
function showUpdatePill(version) {
  const acts = document.getElementById('dragacts');
  if (!acts) return;
  let pill = document.getElementById('updPill');
  if (!pill) {
    pill = document.createElement('button');
    pill.id = 'updPill';
    pill.className = 'updpill';
    acts.appendChild(pill);   // last child = rightmost in the title bar
    pill.addEventListener('click', async () => {
      const v = pill.dataset.version || '';
      // Confirm, because this closes live terminals. Once session-restore lands the cost
      // drops and this prompt can soften — until then it must not be a surprise.
      if (!window.confirm(t('update.confirm', { version: v }))) return;
      await window.glassShell.updaterInstall();
    });
  }
  pill.dataset.version = version || '';
  pill.textContent = t('update.pill');
  pill.title = t('update.tip', { version: version || '' });
  pill.hidden = false;
}

function hideUpdatePill() {
  const pill = document.getElementById('updPill');
  if (pill) pill.hidden = true;
}

if (window.glassShell.onUpdater) {
  window.glassShell.onUpdater(({ channel, payload }) => {
    if (channel === 'ready') showUpdatePill((payload || {}).version);
    else if (channel === 'none' || channel === 'error') hideUpdatePill();
    /* 'checking' | 'available' | 'progress' stay silent in the UI — but NOT in the log. An
       update that is offered and then fails to download used to leave no trace anywhere: the
       pill only appears once a download COMPLETES, so v0.7.0's dead feed looked exactly like
       "no update available". One line per transition is what turns the next silent failure
       into a five-second diagnosis. */
    else console.log('[updater]', channel, JSON.stringify(payload || {}));
    if (channel === 'error') console.warn('[updater] update failed:', (payload || {}).message);
  });
}

/* AI-64 — THE TAB FOLLOWS THE SESSION, instead of freezing whatever it was called at launch.
   A pane's name used to be set once by makeTab() and never revisited, which produced two
   distinct bugs from one cause: `claude --resume` opened a pane hardcoded to the literal
   "resume" while a differently-named session lived inside it, and `/rename` inside a session
   never reached the tab. The app then disagreed with itself — byName() could not find the
   session's pane, so Running offered to "open" an already-open session and fired a SECOND
   resume into the same transcript.

   The fix listens to something we were already being told and ignoring: Claude sets the tty
   title, and `--name` is documented as "shown in the prompt box, /resume picker, and terminal
   title". So the session announces its own identity, and xterm surfaces it as onTitleChange.
   That makes the tab self-correcting for free — whatever the session believes it is called is
   what the tab says, on resume, on rename, forever. No pid plumbing (the pty is a login
   shell, so its pid is not Claude's) and no registry polling. */
function renamePane(id, name) {
  const p = panes.get(id);
  if (!p || !name || name === p.name) return;
  p.name = name;
  const nm = p.tab.querySelector('.tname');
  if (nm) nm.textContent = name;
  // Running correlates by name, so it has to be repainted or the row stays orphaned.
  paintRunning();
}

/* Only a Claude pane may be renamed by its title. A plain shell's title is its cwd or the
   running command, and letting that rename the tab would turn "terminal" into "~/aios" or
   "vim" on every keystroke. */
function paneIsClaude(cmd) {
  if (!cmd) return false;
  return new RegExp('(^|[\\s\'"])' + CLAUDE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([\\s\'"]|$)').test(String(cmd));
}

/* Extract a session name from a tty title. Deliberately CONSERVATIVE: it returns null
   unless the title looks like a session handle, because a wrong name is worse than a stale
   one — a wrong name would make byName() match the WRONG pane and route an interrupt into
   somebody else's session. Tightened against real observed titles (see TITLE_DEBUG). */
function sessionNameFromTitle(title) {
  const raw = String(title || '').trim();
  if (!raw) return null;
  // Strip a leading status glyph (Claude prefixes one) and any "— claude"/"· claude" suffix.
  const cleaned = raw
    .replace(/^[^\w~/]+/, '')
    .replace(/\s*[—–·|-]\s*claude\s*$/i, '')
    .trim();
  // A session handle is the kebab-case slug the app itself generates. Anything with a path
  // separator, a dot, or spaces is a cwd or a command, not a name.
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/i.test(cleaned)) return null;
  return cleaned;
}

/* TEMPORARY (AI-64 investigation): log every title a pty emits so the real format can be
   read off a live session instead of guessed. Remove before shipping. */
const TITLE_DEBUG = false;  // flip on to log the tty titles panes actually emit

function makeTab(id, name, iconName) {
  const tab = document.createElement('button');
  tab.className = 'tab';
  const ic = document.createElement('span'); ic.className = 'ticon'; ic.innerHTML = icon(iconName, 12);
  const nm = document.createElement('span'); nm.className = 'tname'; nm.textContent = name;
  const tx = document.createElement('span'); tx.className = 'tx'; tx.title = t('tab.close'); tx.textContent = '×';
  tab.append(ic, nm, tx);
  tab.addEventListener('click', (e) => {
    if (e.target === tx) { closePane(id); return; }
    setActive(id);
  });

  /* ── drag to reorder, WITHIN ONE STRIP ONLY ──
     Deliberately not a general drag-and-drop surface: a tab cannot cross into the other zone,
     the explorer, or the panel. It moves left or right among its siblings and nothing else,
     which is both what was asked for and the version with no ambiguous drop targets to
     mis-handle. The drop point is decided by which HALF of the hovered tab the cursor is in,
     so a short drag past a neighbour swaps them rather than requiring a full overshoot.

     `effectAllowed = 'move'` plus a same-zone check on drop: the explorer already installs its
     own dragover/drop handlers for file paths, and without the guard a tab dropped there would
     be read as a path. */
  tab.draggable = true;
  tab.addEventListener('dragstart', (ev) => {
    const p = panes.get(id);
    if (!p) return;
    dragTab = { id, zone: zoneOf(p) };
    ev.dataTransfer.effectAllowed = 'move';
    // A tab is not a file: publish an app-private type so no other drop target claims it.
    try { ev.dataTransfer.setData('application/x-aios-tab', String(id)); } catch { /* older engines */ }
    tab.classList.add('dragging');
  });
  tab.addEventListener('dragend', () => { dragTab = null; tab.classList.remove('dragging'); clearDropHint(); });
  tab.addEventListener('dragover', (ev) => {
    if (!dragTab) return;
    const p = panes.get(id);
    if (!p || zoneOf(p) !== dragTab.zone || dragTab.id === id) return;   // same strip, not itself
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    const r = tab.getBoundingClientRect();
    const after = (ev.clientX - r.left) > r.width / 2;
    clearDropHint();
    tab.classList.add(after ? 'drop-after' : 'drop-before');
  });
  tab.addEventListener('dragleave', () => tab.classList.remove('drop-before', 'drop-after'));
  tab.addEventListener('drop', (ev) => {
    if (!dragTab) return;
    const p = panes.get(id);
    if (!p || zoneOf(p) !== dragTab.zone) return;
    ev.preventDefault();
    ev.stopPropagation();
    const r = tab.getBoundingClientRect();
    moveTab(dragTab.zone, dragTab.id, id, (ev.clientX - r.left) > r.width / 2);
    clearDropHint();
    dragTab = null;
  });
  return tab;
}

let dragTab = null;
function clearDropHint() {
  for (const el of document.querySelectorAll('.tab.drop-before, .tab.drop-after')) {
    el.classList.remove('drop-before', 'drop-after');
  }
}

/* Does this command need AIOS to be SET UP? Anything that invokes the Claude CLI does —
   which is every ritual, agent, skill, command and frequent task. A plain shell terminal
   does not, and neither do the setup remedies themselves (installing Claude, signing in),
   or the operator could never get out of the hole. */
const needsSetup = (cmd) => {
  if (!cmd) return false;
  const c = String(cmd);
  if (!new RegExp('(^|[\\s\'"])' + CLAUDE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([\\s\'"]|$)').test(c)) return false;
  /* The remedies are exempt, or the operator could never climb out. Three of them:
     /login and /logout fix the account; the aios-setup session IS the setup; and the
     cold-start interview is what writes the declared context the gate asks for. */
  return !/\/(login|logout)\b/.test(c) && !/--name\s+aios-setup\b/.test(c) && !/cold-start-interview/.test(c);
};

/* One gate for every runnable action. Before this, a missing prerequisite surfaced as
   `command not found` inside a terminal — the operator asked for "Launch AIOS" and got a
   shell error. Now the app takes them to the place that can fix it and says which piece is
   missing. Gated HERE because createPane is the single chokepoint every claude command
   passes through: menu, panel, palette, home cards, frequent tasks, the bus. */
async function ensureRunnable(cmd) {
  if (!needsSetup(cmd)) return true;
  let r;
  try { r = await window.glassShell.readiness(); } catch { return true; } // cannot tell → let it run
  if (r.ready) return true;
  const missing = [
    !r.claude && (r.claudeWhere === 'disk' ? t('ready.claudeOffPath') : t('ready.claude')),
    !r.framework && t('ready.framework'),
    !r.vault && t('ready.vault'),
    !r.signedIn && t('ready.signedIn'),
  ].filter(Boolean);
  toast(t('ready.blocked', { missing: missing.join(' · ') }));
  openSetupTab();
  return false;
}

/* The second gate, and the one that is easy to talk yourself out of: a vault can be fully
   INSTALLED and still be the shipped template. Every ritual then runs perfectly and lies —
   /aios:today will plan a day for a person the vault knows nothing about, write the note, and
   look like it worked. That is worse than an error, because the operator has no reason to
   doubt it, and the first thing they learn about AIOS is that its output is generic.
   So rituals wait until the setup session has actually produced a personalized vault. The
   check is evidence read from the vault, never a flag the app set (see core/personalized.ts),
   and the remedies above are exempt so the way out is always open. */
async function ensurePersonalized(cmd) {
  if (!needsSetup(cmd)) return true;
  let r;
  try { r = await window.glassShell.readiness(); } catch { return true; }   // cannot tell → allow
  if (!r.ready || r.personalized) return true;   // not-ready is the other gate's job to explain
  toast(t('ready.notPersonalized'));
  openSetupTab();
  return false;
}

async function createPane({ name = 'terminal', cmd, cwd, bypassReady = false } = {}) {
  // the Setup tab's own fix buttons pass bypassReady — they ARE the remedy
  if (!bypassReady && !(await ensureRunnable(cmd))) return null;
  if (!bypassReady && !(await ensurePersonalized(cmd))) return null;
  const el = document.createElement('div');
  el.className = 'pane termcard';
  const term = new Terminal({
    // Apple Color Emoji last: the statusline is full of emoji (📁 🌿 ⚡ 👤) and none of the
    // mono faces carry them, so without a fallback they render as a substitute glyph of the
    // wrong advance width and everything after them shifts.
    fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, 'Apple Color Emoji', monospace",
    fontSize: TERMFONT,
    lineHeight: 1.0,          // xterm's native density — 1.35 then 1.1 still read as leaded
    cursorBlink: true,
    scrollback: 8000,
    theme: termTheme(THEME),
    rightClickSelectsWord: true,           // right-click selects the word under the cursor
    macOptionClickForcesSelection: true,   // ⌥-drag selects even over mouse-mode TUIs
    // Option must send ESC-prefixed sequences, not composed characters — this is what makes
    // ⌥↵ (newline in Claude's composer) and ⌥←/→ (word jumps) actually reach the TUI.
    macOptionIsMeta: true,
    // required to select a unicode width table below; without it xterm throws on
    // term.unicode.activeVersion and we silently keep the Unicode 6 widths
    allowProposedApi: true,
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  // cwd powers "open terminal here"; main validates it against the allowed roots and
  // falls back to the framework root. It was accepted there and silently dropped here.
  // `name` travels as data, not smuggled inside the command string — see termEnv().
  const id = await window.glassShell.ptySpawn({ cols: 80, rows: 24, cmd, cwd, name });
  const tab = makeTab(id, name, 'term');
  const p = { kind: 'term', name, el, tab, term, fit, exited: false, cmd, isSession: paneIsClaude(cmd) };
  panes.set(id, p);
  homePane(id, p, { fresh: true });
  // raw tty fills the pane — type straight into the session; drag with the mouse
  // to select, which copies to the clipboard (xterm-native, no composer bar).
  const twrap = document.createElement('div'); twrap.className = 'twrap';
  el.append(twrap);
  term.open(twrap);
  // GPU renderer. xterm's DEFAULT is the DOM renderer, which draws every cell as spans: it
  // ignores devicePixelRatio (hence the soft, low-res look next to Antigravity's terminal)
  // and repaints a frame behind, which is the "mega lag" where a click's result appears late.
  // WebGL is the renderer VS Code and Antigravity use. If the GPU context is lost or refused
  // we dispose the addon and fall back to DOM rather than showing a dead terminal.
  try {
    if (window.WebglAddon && window.WebglAddon.WebglAddon && !NO_WEBGL) {
      const gl = new window.WebglAddon.WebglAddon();
      gl.onContextLoss(() => { try { gl.dispose(); } catch { /* already gone */ } });
      term.loadAddon(gl);
      p.gl = gl;
    }
  } catch { /* no GPU path available — DOM renderer still works */ }
  /* GLYPH FLICKER UNDER RAPID FULL-SCREEN REDRAWS.
     Reported in the `claude --resume` picker: holding arrow-down through a long list garbles
     glyphs, it is independent of window size, and typing in the search box clears it. That
     signature is the WebGL renderer's TEXTURE ATLAS going stale, not a layout fault — typing
     "fixes" it because it forces a full repaint, which is a symptom of a rendering cache, not
     of geometry.
     So: after a burst of output settles, clear the atlas once. Debounced because clearing on
     every frame would cost more than the artifact does, and only while the pane is visible.
     Honest status: this is a targeted MITIGATION for the most likely cause, not a diagnosis —
     the artifact has not been reproduced here. `AIOS_NO_WEBGL=1` disables the renderer entirely
     and is the way to PROVE it: if the flicker survives with WebGL off, the cause is elsewhere
     and this code should be reverted rather than kept as a charm. */
  let atlasTimer = null;
  let bytesSinceClear = 0;
  let lastClear = 0;
  /* GATE THE CLEAR ON VOLUME, NOT MERELY ON QUIET. Debouncing on "output stopped" sounds
     right and is wrong here: a running Claude session ticks its elapsed-time counter every
     second, so output settles constantly and the shared atlas would be cleared — and every
     terminal repainted — roughly once a second, forever. The artifact this exists for comes
     from SUSTAINED full-screen redraws (holding arrow-down through a picker), which move
     tens of KB; a spinner tick moves a handful of bytes. So require a real burst, and never
     clear more than once every few seconds. */
  const ATLAS_BURST_BYTES = 64 * 1024;
  const ATLAS_MIN_GAP_MS = 5000;
  const scheduleAtlasClear = (n) => {
    if (!p.gl) return;
    bytesSinceClear += n || 0;
    if (atlasTimer) clearTimeout(atlasTimer);
    atlasTimer = setTimeout(() => {
      atlasTimer = null;
      if (p.exited || !paneShown(p)) return;
      const now = performance.now();
      if (bytesSinceClear < ATLAS_BURST_BYTES || now - lastClear < ATLAS_MIN_GAP_MS) return;
      bytesSinceClear = 0;
      lastClear = now;
      try { p.gl.clearTextureAtlas(); } catch { /* addon disposed */ }
      /* THE ATLAS IS SHARED, NOT PER-TERMINAL — verified in the addon: `acquireTextureAtlas`
         keeps a global cache with `ownedBy` arrays, so every terminal on the same
         font/theme/dpr uses ONE atlas. Clearing it here evicts glyphs out from under every
         OTHER terminal — including the ones you cannot see.
         REPAINT ALL OF THEM, NOT JUST THE VISIBLE ONES. Repainting only what was on screen
         was the previous attempt and it left the exact reported symptom: a background session
         keeps printing against a re-packed atlas, so its canvas fills with garbage while
         hidden, and you meet that garbage on switching. It then clears about a second later —
         the running session's own elapsed-time counter ticks, forces a render, and the frame
         comes back correct. That one-second self-heal is the signature: the DATA was always
         fine, only the painted frame was stale.
         Now that a hidden terminal keeps its box (see setPaneShown) it is still attached and
         can repaint on demand, so there is no reason to exclude it. */
      for (const q of liveTerms()) if (q !== p) repaintTerm(q);
    }, 180);
  };
  p.scheduleAtlasClear = scheduleAtlasClear;

  /* Emoji are WIDE (2 cells). xterm defaults to Unicode 6 tables, where most of them measure
     1 — so the terminal's idea of the cursor position drifts from the writer's on every
     emoji, and a line like the statusline ends up visibly mis-spaced (📁obsidian instead of
     📁 obsidian, values overlapping the label after them). The unicode11 addon supplies the
     modern width tables; activeVersion must be set for it to take effect. */
  try {
    if (window.Unicode11Addon && window.Unicode11Addon.Unicode11Addon) {
      term.loadAddon(new window.Unicode11Addon.Unicode11Addon());
      term.unicode.activeVersion = '11';
    }
  } catch { /* keep the default tables rather than failing to open a terminal */ }
  setActive(id);
  fit.fit();
  ensureTermRoom(id, p);
  pushPtyGeom(id, p);
  /* ONLY NOW run the opening command. Everything above establishes the real geometry — fit
     measures the pane, ensureTermRoom may grow the dock, pushPtyGeom tells the pty. Launching
     the command before this point ran it at 80×24 and then resized underneath it, which is
     what garbled the `claude --resume` picker. A TUI must never be started at a lie. */
  if (cmd) void window.glassShell.ptyRun(id, cmd);
  term.attachCustomKeyEventHandler((e) => {
    if (e.type === 'keydown' && handleChord(e)) return false; // ⌘⌥G chords win everywhere
    if ((e.metaKey || e.ctrlKey) && ['k', 'p', 'j'].includes(e.key.toLowerCase())) return false; // app shortcuts win
    if (e.type !== 'keydown' || !e.metaKey || e.altKey) return true;
    // ⌘ conventions every macOS terminal user expects — and that a non-technical operator
    // will try first. Without these, ⌘C sent nothing and ⌘←/→ did nothing at all.
    const k = e.key;
    if (k === 'c') { const sel = term.getSelection(); if (sel) { void window.glassShell.copyText(sel); return false; } return true; }
    /* ⌘V is deliberately NOT handled here. It used to be, and it pasted EVERYTHING TWICE:
       returning false suppresses xterm's KEYBOARD handling but not the browser's native
       `paste` event, which xterm also listens for on its helper textarea — so our write and
       xterm's write both landed. (`role: 'editMenu'` in menu.ts is what delivers that native
       paste, so the built-in path was always live.)
       Removing ours also fixes something quieter: xterm wraps pasted text in BRACKETED PASTE
       sequences when the mode is on, and our raw ptyWrite did not — so multi-line pastes into
       Claude Code were being read as a series of submissions instead of one block. The
       hand-rolled path was not just redundant, it was the wrong one. ⌘C still needs help
       (xterm has no native copy for a terminal selection), which is why it stays. */
    if (k === 'ArrowLeft') { window.glassShell.ptyWrite(id, '\x01'); return false; }   // line start
    if (k === 'ArrowRight') { window.glassShell.ptyWrite(id, '\x05'); return false; }  // line end
    if (k === 'ArrowUp') { term.scrollToTop(); return false; }
    if (k === 'ArrowDown') { term.scrollToBottom(); return false; }
    if (k === 'Backspace') { window.glassShell.ptyWrite(id, '\x15'); return false; }   // clear the line
    return true;
  });
  // the container can change size without a window resize (splitter drag, zone expand,
   // interface-size zoom, webfont landing) — observe it directly
  if (typeof ResizeObserver === 'function') {
    let raf = 0;
    p.ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (p.exited) return;
        try { fit.fit(); } catch { return; }
        pushPtyGeom(id, p);
      });
    });
    p.ro.observe(twrap);
  }
  // drop a file/folder onto THIS terminal → insert its quoted path (not the active one:
  // the pane under the pointer is the one the operator meant)
  attachDropZone(el, (paths) => { window.glassShell.ptyWrite(id, paths.map(xQuote).join(' ') + ' '); setActive(id); });
  term.onData((d) => window.glassShell.ptyWrite(id, d));
  attachPathLinks(term, cwd);
  /* AI-64: the session tells us its own name through the tty title. */
  /* Titles CONFIRM a session; only the REGISTRY can declare one over.
     My last two attempts both got this wrong in opposite directions. Keying off the launch
     command missed a session started by hand in a plain terminal. Then treating "this title is
     not a live session name" as evidence of an ending marked EVERY pane "(ended)" — because a
     session emits many titles, most of which are not its name, and the registry snapshot can be
     a beat stale. Absence of evidence was being read as evidence of absence.
     So: a title may only ever CONFIRM (positive, checked against the live registry). Ending is
     decided elsewhere, from the registry itself, where the fact actually lives. */
  term.onTitleChange((title) => {
    if (TITLE_DEBUG) console.log('[title]', id, JSON.stringify(String(title).slice(0, 120)));
    const nm = sessionNameFromTitle(title);
    if (!nm) return;
    /* TWO QUESTIONS, and conflating them was the bug. Measured titles: "✳ keen-otter",
       "✳ koala", "claude · resume".
         NAMING — what should the tab say? Cosmetic and safe, so the title alone decides.
           Requiring a registry match here meant a session displaying "koala" while registered
           as "brisk-koala" never renamed at all.
         DELIVERABILITY — may the bus type into this pane? That needs PROOF, because getting it
           wrong routes someone's message into the wrong session. Only a live registry match
           earns it, and only that name may later be declared ended. */
    renamePane(id, nm);
    const live = ((pulse.lastRunning || {}).running || []).some((a) => a.name === nm);
    if (!live) return;
    p.isSession = true;
    p.confirmedName = nm;
  });
  // one source of truth for geometry pushes, so xterm's own resize event cannot re-send
  // a size pushPtyGeom already sent (or vice versa)
  term.onResize(() => pushPtyGeom(id, p));
  // select-to-copy: mirror the selection to the clipboard as it changes, so a
  // mouse drag in the terminal copies (matches Claude Code's terminal behavior).
  term.onSelectionChange(() => { const sel = term.getSelection(); if (sel) void window.glassShell.copyText(sel); });
  paintRunning(); // reflect the new terminal in the RUNNING card immediately
  return id;
}

/* Type text into a pty and THEN submit, as two writes. Claude Code turns on bracketed paste:
   a single write of `text + CR` arrives as ONE paste, and inside a paste the CR is literal —
   it lands as a newline in the composer instead of sending. That is exactly the command bus's
   `send` bug: the message arrived, but never went. A person pastes and then presses Enter,
   after the paste has closed; so do we. */
function submitToPty(id, text) {
  if (!text) return;
  window.glassShell.ptyWrite(id, text);
  setTimeout(() => window.glassShell.ptyWrite(id, '\r'), 80);
}

function closePane(id) {
  const p = panes.get(id);
  if (!p) return;
  const z = zoneOf(p);
  if (p.ro) { try { p.ro.disconnect(); } catch { /* already gone */ } }
  if (p.gl) { try { p.gl.dispose(); } catch { /* already gone */ } }
  if (p.kind === 'term' && !p.exited) window.glassShell.ptyKill(id);
  p.el.remove();
  p.tab.remove();
  panes.delete(id);
  unregisterTab(id);
  if (active[z] === id) ensureActive(z);
  updateEmpty();
  /* Unconditional now. It used to re-split only when the LAST TERMINAL closed, which was
     right when only the dock could hide; the editor zone hides on the same rule today, so
     closing the last editor pane has to re-run the split too or the zone stays open empty. */
  if (split) applySplit();
  paintRunning();
}

// In-app browser pane (#14): open a URL in a tab (Electron <webview>) instead of
// the external browser — the Manual + any operator-opened URL. Modeled on the view
// pane; kind 'browser' so closePane skips ptyKill. Isolated persistent partition.
function openBrowserPane(url, label) {
  for (const [id, pane] of panes) {
    if (pane.kind === 'browser' && pane.url === url) { setActive(id); return; }
  }
  const id = 'b' + (++viewSeq);
  const el = document.createElement('div');
  el.className = 'pane browser';
  const head = document.createElement('div'); head.className = 'vhead';
  const title = document.createElement('span'); title.className = 'vtitle'; title.textContent = label || url;
  head.appendChild(title);
  const acts = document.createElement('span'); acts.className = 'vacts';
  const ext = document.createElement('button'); ext.className = 'vbtn'; ext.innerHTML = icon('expand', 13); ext.title = t('browser.openExternal');
  ext.addEventListener('click', () => void window.glassShell.openExternal(url));
  acts.appendChild(ext); head.appendChild(acts);
  const body = document.createElement('div'); body.className = 'vbody';
  const wv = document.createElement('webview');
  wv.setAttribute('src', url);
  wv.setAttribute('partition', 'persist:aios-browser');
  wv.style.cssText = 'flex:1;width:100%;height:100%;border:0;';
  body.appendChild(wv);
  el.append(head, body);
  const tab = makeTab(id, label || 'browser', 'html');
  const paneObj = { kind: 'browser', name: label || 'browser', el, tab, url };
  panes.set(id, paneObj);
  homePane(id, paneObj, { fresh: true });
  setActive(id);
}

/* Re-flow xterm AND tell the pty its new size. Fitting without resizing the pty leaves the
   two geometries disagreeing, which is what produced a leftover strip under the statusline and
   mouse clicks landing in the wrong column (Claude draws for the pty's cols; xterm reports
   clicks in its own grid). Interface-size zoom changes pixels with no window-resize event, so
   this can't rely on resize alone — see the per-pane ResizeObserver in createPane. */
/* Push a resize to the pty ONLY when the grid actually changed.
   Every ptyResize makes the session redraw its whole TUI, statusline included. fitTerms()
   runs on each mousemove of a splitter drag, and measured over a 40px drag the cell
   geometry was unchanged on 39 of 40 — so the statusline was repainting continuously for no
   reason, which is what read as "updating weirdly". xterm's own fit() is cheap and
   idempotent; it is the pty round trip and the redraw it triggers that are not. */
function pushPtyGeom(id, p) {
  if (!p.term) return false;
  const g = p.term.cols + 'x' + p.term.rows;
  if (g === p.lastGeom) return false;
  p.lastGeom = g;
  window.glassShell.ptyResize(id, p.term.cols, p.term.rows);
  return true;
}

function fitTerms() {
  requestAnimationFrame(() => {
    for (const [id, p] of panes) {
      if (p.kind !== 'term' || !paneShown(p) || p.exited) continue;
      try { p.fit.fit(); } catch { continue; }
      pushPtyGeom(id, p);
    }
  });
}

window.glassShell.onPtyData((m) => {
  const p = panes.get(m.id);
  if (!p || p.kind !== 'term') return;
  p.term.write(m.data);
  if (p.scheduleAtlasClear) p.scheduleAtlasClear((m.data || '').length);   // volume-gated; see its definition
  // pty-grade theater: tail the latest meaningful output line into the ticker
  // (throttled — TUI spinners redraw constantly; the ticker breathes, not thrashes)
  const now = Date.now();
  if (now - (p.lastLineAt || 0) < 600) return;
  const line = lastPtyLine(m.data);
  if (line && line !== p.lastLine) { p.lastLine = line; p.lastLineAt = now; tickTicker('term-' + m.id, line); }
});
window.glassShell.onPtyExit((m) => {
  const p = panes.get(m.id);
  if (p && p.kind === 'term') { p.exited = true; p.term.write('\r\n\x1b[2m[session ended]\x1b[0m\r\n'); paintRunning(); }
  // a Health fix terminal ended → re-run the doctor so the row proves (or denies) the fix
  if (healthFixPanes.delete(m.id)) setTimeout(() => void refreshHealth(), 600);
  // an Onboarding fix terminal ended → re-verify the stepper (auto-advance on proof)
  if (onboardingFixPanes.delete(m.id) && onboardingRepaint) setTimeout(() => void onboardingRepaint(), 600);
});
window.addEventListener('resize', fitTerms);
// The + button → a small menu: session (a claude session) · terminal (shell) · browser (in-app webview) — #15
let newTabMenuEl = null;
function newTabMenu() {
  if (newTabMenuEl) return newTabMenuEl;
  newTabMenuEl = el('div', 'xctx'); newTabMenuEl.hidden = true;
  const item = (label, fn) => { const b = el('button', '', label); b.addEventListener('click', () => { newTabMenuEl.hidden = true; void fn(); }); newTabMenuEl.appendChild(b); };
  item(t('newtab.session'), () => spawnWorkerFlow());
  item(t('newtab.terminal'), () => createPane({ name: 'terminal' }));
  item(t('newtab.file'), () => quickOpen());   // the ⌘P dialog — same door as the loupe
  item(t('newtab.browser'), async () => {
    const url = await inputModal(t('newtab.browserTitle'), t('newtab.browserPlaceholder'));
    if (!url) return;
    const u = /^https?:\/\//i.test(url) ? url : 'https://' + url;
    openBrowserPane(u, u.replace(/^https?:\/\//, '').split('/')[0]);
  });
  document.body.appendChild(newTabMenuEl);
  const hide = () => { newTabMenuEl.hidden = true; };
  window.addEventListener('click', hide); window.addEventListener('blur', hide); window.addEventListener('scroll', hide, true);
  return newTabMenuEl;
}
for (const btn of document.querySelectorAll('.newTab')) {
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const m = newTabMenu();
    m.hidden = false;
    anchorMenu(m, btn.getBoundingClientRect());
  });
}

/* ── viewers ──────────────────────────────────────────────────────────────── */
const MD_EXT = /\.md$/i;
const HTML_EXT = /\.html?$/i;
const IMG_EXT = /\.(png|jpe?g|gif|svg|webp)$/i;
const PDF_EXT = /\.pdf$/i;

/* ── full-screen (zen) — maximize the active pane over the whole window ─────── */
let zenOn = false;
function setZen(on) {
  zenOn = on;
  document.body.classList.toggle('zen', on);
  paintExpandButtons();   // the zone controls reflect zen too
  fitTerms();
}
/* Expand = give THIS zone the room, without hiding the panel or explorer. It redistributes
   the work area only (compressing the editor for a terminal, or the terminals for an
   editor), so the layout you chose survives. Clicking again restores the balance. With no
   terminal dock open there is no zone to trade against, so it falls back to zen. */
const TH_DEFAULT = 0.38, TH_MAX = 0.93, TH_MIN = 0.07;
/* Opening something into a CRUSHED zone used to put it where you could not see it: maximize the
   terminals, then open a file, and the editor is a sliver — the app did exactly as asked and
   appeared to do nothing. Asking for a thing is an implicit request to see it, so landing in a
   squeezed zone restores the balanced split. Only from the squeezed extreme: a deliberate 70/30
   is a preference and gets left alone, and this never touches a zone that is already visible. */
function revealZone(z) {
  if (!split) return;
  const squeezed = z === 'term' ? th <= TH_MIN + 0.01 : th >= TH_MAX - 0.01;
  if (!squeezed) return;
  th = TH_DEFAULT;
  applySplit(); saveLayout(); fitTerms();
}
/* Claude Code hides its statusline when the grid is too short, so a session opening into a
   shallow dock loses it. Grow the dock — only ever grow, and only to TH_ROOM — until the grid
   clears the bar, then re-sync the pty (the grid is authoritative; the pty must match).
   MIN measured against a live session, not guessed: statusline renders at 16 rows and is gone
   by 13, so 18 clears the boundary with a row of margin. Growth is creation-only — if the
   operator later squeezes the dock themselves, that is their call and we don't fight it. */
const MIN_TERM_ROWS = 18, TH_ROOM = 0.62;
function ensureTermRoom(id, p) {
  if (!split || zoneOf(p) !== 'term' || !p.term) return;
  const tz = document.getElementById('termzone');
  if (!tz || !tz.getBoundingClientRect().height) return;   // dock not laid out yet
  let grew = false, guard = 0;
  while (p.term.rows < MIN_TERM_ROWS && th < TH_ROOM - 0.001 && guard++ < 14) {
    th = Math.min(TH_ROOM, th + 0.04);
    tz.style.height = Math.round(th * 100) + '%';           // measure at the new height
    try { p.fit.fit(); } catch { break; }
    grew = true;
  }
  if (grew) { applySplit(); saveLayout(); fitTerms(); }
}
function expandZone(zone) {
  const anyTerm = [...panes.values()].some((p) => p.kind === 'term');
  if (!split || !anyTerm) { setZen(!zenOn); return; }
  const maxed = zone === 'term' ? th >= TH_MAX - 0.01 : th <= TH_MIN + 0.01;
  const squeezed = zone === 'term' ? th <= TH_MIN + 0.01 : th >= TH_MAX - 0.01;
  // at EITHER extreme the click restores balance — the squeezed zone's button used to
  // maximize it instead, which just swapped which half was crushed
  if (maxed || squeezed) th = TH_DEFAULT;
  else th = zone === 'term' ? TH_MAX : TH_MIN;
  applySplit(); saveLayout(); fitTerms();
}
/* Expand belongs to the ZONE, not to an item inside it: one control per strip, beside that
   strip's (+). Per-pane buttons meant every terminal carried its own copy of a zone-wide
   action — which read as if it applied to that terminal alone. */
for (const [id, zone] of [['zexpMain', 'main'], ['zexpTerm', 'term']]) {
  const b = document.getElementById(id);
  if (b) b.addEventListener('click', () => expandZone(zone));
}

/* One button, three honest states: expand · collapse (you're maximized) · back to half
   (you're the squeezed one). Without this the same glyph meant three different things. */
function paintExpandBtn(btn, zone) {
  const maxed = zone === 'term' ? th >= TH_MAX - 0.01 : th <= TH_MIN + 0.01;
  const squeezed = zone === 'term' ? th <= TH_MIN + 0.01 : th >= TH_MAX - 0.01;
  const state = !split ? 'expand' : maxed ? 'collapse' : squeezed ? 'half' : 'expand';
  btn.innerHTML = icon(state === 'collapse' ? 'compress' : state === 'half' ? 'comfort' : 'expand', 13);
  btn.title = t('viewer.' + state);
}
function paintExpandButtons() {
  const anyTerm = [...panes.values()].some((p) => p.kind === 'term');
  for (const [id, zone] of [['zexpMain', 'main'], ['zexpTerm', 'term']]) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    btn.hidden = !(split && anyTerm);   // nothing to trade against → no control
    paintExpandBtn(btn, zone);
  }
  const lm = document.getElementById('zlabMain'); if (lm) lm.textContent = t('zone.workspace');
  const lt = document.getElementById('zlabTerm'); if (lt) lt.textContent = t('zone.terminals');
}
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && zenOn && !document.querySelector('.modal-wrap')) { e.preventDefault(); setZen(false); }
}, true);

/* ── syntax-highlighted editor — a code-editor-style source/edit view ──────────
   A highlighted <pre> sits behind a transparent <textarea> (caret + input), so
   editing shows colors live (the CodeJar/Prism overlay technique), via highlight.js. */
const LANG_MAP = { md: 'markdown', markdown: 'markdown', mdx: 'markdown', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', mts: 'typescript', json: 'json', jsonc: 'json', css: 'css', scss: 'scss', less: 'less', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', py: 'python', sh: 'bash', bash: 'bash', zsh: 'bash', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', sql: 'sql', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', c: 'c', h: 'c', cpp: 'cpp', txt: '' };
function langFor(name) { return LANG_MAP[(name.split('.').pop() || '').toLowerCase()] ?? ''; }
function buildCodeEditor(initial, lang, hooks, gitPath) {
  const wrap = el('div', 'codeedit');
  const pre = el('pre', 'codehl hljs');
  const code = document.createElement('code'); pre.appendChild(code);
  const ta = document.createElement('textarea'); ta.className = 'codeta'; ta.spellcheck = false; ta.value = initial;
  ta.setAttribute('wrap', 'off');
  wrap.append(pre, ta);
  /* UNCOMMITTED-CHANGE BARS. A 3px column at the left edge, NOT a real gutter: this editor is
     a highlighted <pre> sitting exactly behind a transparent <textarea>, and the two must align
     to the pixel or the caret drifts from the glyphs. Inserting a gutter would shift both and
     put that alignment at risk for a decoration. An overlay costs nothing and cannot break it.
     Positions come from git's own hunk headers (`git diff -U0`, unstaged AND --cached, so a
     partly-staged file still shows everything uncommitted). */
  const gut = el('div', 'codegutter');
  wrap.appendChild(gut);
  let dirtyRanges = [];
  const paintGutter = () => {
    const cs = getComputedStyle(pre);
    const lh = parseFloat(cs.lineHeight) || 18;
    const padTop = parseFloat(cs.paddingTop) || 0;
    gut.replaceChildren();
    for (const [from, to] of dirtyRanges) {
      const d = el('div', 'dirtymark');
      d.style.top = (padTop + (from - 1) * lh - ta.scrollTop) + 'px';
      d.style.height = Math.max(2, (to - from + 1) * lh) + 'px';
      gut.appendChild(d);
    }
  };
  /* ── SKIMMING CHANGES ──
     Two different jobs, so two different affordances:

     The RULER answers "where are the changes?" without scrolling at all — a full-height strip
     on the right with every hunk at its proportional position. That is the piece that removes
     the hunt: you see the shape of the diff in one glance, and click to land on any of it.
     A left-margin bar can only ever tell you about the screenful you are already looking at.

     The STEPPER answers "take me through them, in order" — ‹ › with a count, wired to ⌥↑/⌥↓.
     Buttons rather than shortcut-only because this app has non-technical operators; a
     shortcut nobody discovers is not a feature. */
  const over = el('div', 'codeoverview');
  wrap.appendChild(over);
  let cursor = -1;   // which hunk the stepper last landed on
  const totalLines = () => Math.max(1, ta.value.split('\n').length);
  const lineH = () => parseFloat(getComputedStyle(pre).lineHeight) || 18;

  const paintOverview = () => {
    const n = totalLines();
    over.replaceChildren();
    for (const [from, to] of dirtyRanges) {
      const d = el('div', 'ovmark');
      d.style.top = ((from - 1) / n * 100) + '%';
      d.style.height = Math.max(0.6, (to - from + 1) / n * 100) + '%';
      over.appendChild(d);
    }
  };
  // click the ruler → jump to that proportional point in the file
  over.addEventListener('click', (ev) => {
    const r = over.getBoundingClientRect();
    const line = Math.round(((ev.clientY - r.top) / Math.max(1, r.height)) * totalLines());
    centerLine(line);
  });

  function centerLine(line) {
    const lh = lineH();
    const padTop = parseFloat(getComputedStyle(pre).paddingTop) || 0;
    ta.scrollTop = Math.max(0, padTop + (line - 1) * lh - ta.clientHeight / 2);
    sync();
  }
  function step(dir) {
    if (!dirtyRanges.length) return;
    cursor = (cursor + dir + dirtyRanges.length) % dirtyRanges.length;
    if (cursor < 0) cursor = dirtyRanges.length - 1;
    centerLine(dirtyRanges[cursor][0]);
    hooks.onStep?.(cursor + 1, dirtyRanges.length);
  }

  const refreshGutter = async () => {
    if (!gitPath) return;
    try { dirtyRanges = (await window.glassShell.dirtyLines(gitPath)) || []; } catch { dirtyRanges = []; }
    // hunks come from two diffs (unstaged + cached) so they arrive unsorted and can overlap
    dirtyRanges.sort((x, z) => x[0] - z[0]);
    paintGutter();
    paintOverview();
    hooks.onChanges?.(dirtyRanges.length);
  };
  const hl = () => {
    let t = ta.value; if (t.endsWith('\n')) t += ' '; // render the trailing blank line
    if (lang && window.hljs && window.hljs.getLanguage(lang)) {
      try { code.innerHTML = window.hljs.highlight(t, { language: lang, ignoreIllegal: true }).value; return; } catch { /* fall through */ }
    }
    code.textContent = t;
  };
  const sync = () => { pre.scrollTop = ta.scrollTop; pre.scrollLeft = ta.scrollLeft; paintGutter(); };
  ta.addEventListener('input', () => { hl(); hooks.onInput(ta.value); });
  ta.addEventListener('scroll', sync);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart, en = ta.selectionEnd; ta.value = ta.value.slice(0, s) + '  ' + ta.value.slice(en); ta.selectionStart = ta.selectionEnd = s + 2; hl(); hooks.onInput(ta.value); }
    else if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); hooks.onSave(ta.value); }
    // ⌥↓ / ⌥↑ — next / previous uncommitted change
    else if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) { e.preventDefault(); step(e.key === 'ArrowDown' ? 1 : -1); }
  });
  ta.addEventListener('blur', () => hooks.onBlur(ta.value));
  hl();
  void refreshGutter();
  wrap.refreshGutter = refreshGutter;   // the viewer re-reads git after a save
  wrap.stepChange = step;               // the header stepper drives the same path as ⌥↑/⌥↓
  return wrap;
}

async function openViewer(p) {
  for (const [id, pane] of panes) {
    if (pane.kind === 'view' && pane.path === p) { setActive(id); return; }
  }
  const file = await window.glassShell.fsRead(p);
  if (!file) { toast(t('viewer.cannotOpen', { name: String(p).split('/').pop() })); return; }
  const name = file.path.split('/').pop();
  const id = 'v' + (++viewSeq);
  const el = document.createElement('div');
  el.className = 'pane viewer';

  const head = document.createElement('div');
  head.className = 'vhead';
  const title = document.createElement('span'); title.className = 'vtitle';
  const parts = file.path.split('/');
  const crumb = document.createElement('span'); crumb.className = 'vcrumb';
  crumb.textContent = (parts[parts.length - 2] || '') + ' › ';
  title.append(crumb, document.createTextNode(name));
  head.appendChild(title);
  const body = document.createElement('div');
  body.className = 'vbody';
  el.append(head, body);

  const tab = makeTab(id, name, fileIconName(name));
  const paneObj = { kind: 'view', name, el, tab, path: file.path };
  panes.set(id, paneObj);
  homePane(id, paneObj, { fresh: true });

  const renderable = MD_EXT.test(name) || HTML_EXT.test(name) || IMG_EXT.test(name) || PDF_EXT.test(name);
  const editable = !(IMG_EXT.test(name) || PDF_EXT.test(name));
  // the operator's "Open files in" preference decides the initial mode (a non-renderable
  // file is always source regardless)
  let mode = renderable && OPENNOTESIN !== 'source' ? 'rendered' : 'source';
  let saveTimer = null;
  const setDirty = (on) => { paneObj.dirty = on; tab.classList.toggle('dirty', on); };
  async function save(content, repaint) {
    file.content = content;
    const ok = await window.glassShell.fsWrite(file.path, content);
    setDirty(!ok);
    if (!ok) toast(t('viewer.saveFailed', { name }));
    else if (repaint) paint();
  }

  if (renderable && editable) {
    const seg = document.createElement('div');
    seg.className = 'seg';
    const mk = (label, m) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.addEventListener('click', () => { if (mode !== m) { mode = m; sync(); paint(); } });
      seg.appendChild(b);
      return b;
    };
    const bR = mk(t('viewer.rendered'), 'rendered');
    const bS = mk(t('viewer.edit'), 'source');
    const sync = () => { bR.classList.toggle('on', mode === 'rendered'); bS.classList.toggle('on', mode === 'source'); };
    sync();
    head.appendChild(seg);
  }
  // HTML deliverables → download as a high-res PNG
  if (HTML_EXT.test(name)) {
    const png = document.createElement('button'); png.className = 'vbtn'; png.innerHTML = icon('download', 13) + ' PNG'; png.title = t('viewer.pngTitle');
    png.addEventListener('click', async () => {
      const label = png.innerHTML; png.disabled = true; png.textContent = t('viewer.rendering');
      const r = await window.glassShell.htmlToPng(file.path);
      png.disabled = false; png.innerHTML = label;
      if (r && r.out) { toast(t('viewer.savedPng', { w: r.w, h: r.h })); void openViewer(r.out); }
      else toast(t('viewer.pngFailed'));
    });
    head.appendChild(png);
  }

  function paint() {
    body.replaceChildren();
    body.classList.toggle('fill', mode === 'rendered' && (HTML_EXT.test(name) || PDF_EXT.test(name)));
    if (mode === 'source') {
      // source IS the editor — now syntax-highlighted (code-editor style): autosaves
      // 700ms after you stop typing, on blur, and on ⌘S.
      const after = (v) => save(v).then(() => { try { editor.refreshGutter?.(); } catch { /* gone */ } });
      /* The change stepper lives in the viewer header and only exists when the file HAS
         uncommitted changes — a "0 changes ‹ ›" control is noise on a clean file. */
      /* NOTE: `el` is SHADOWED in this function (line ~2122 declares a local <div> named el),
         so the global el() helper is unreachable here. Calling it threw "el is not a function"
         before the viewer rendered anything — every file, every type, silently blank. Build
         these with document.createElement directly rather than reintroducing the trap. */
      const mkEl = (tag, cls, text) => {
        const n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text) n.textContent = text;
        return n;
      };
      const chg = mkEl('span', 'chgnav'); chg.hidden = true;
      const chgN = mkEl('span', 'chgcount');
      const mk = (label, dir) => { const b2 = mkEl('button', 'chgbtn', label); b2.addEventListener('click', () => editor.stepChange?.(dir)); return b2; };
      chg.append(chgN, mk('‹', -1), mk('›', 1));
      const editor = buildCodeEditor(file.content, langFor(name), {
        onInput: (v) => { setDirty(true); if (saveTimer) clearTimeout(saveTimer); saveTimer = setTimeout(() => void after(v), 700); },
        onSave: (v) => { if (saveTimer) clearTimeout(saveTimer); void after(v); },
        onBlur: (v) => { if (paneObj.dirty) { if (saveTimer) clearTimeout(saveTimer); void after(v); } },
        onChanges: (n) => { chg.hidden = n === 0; chgN.textContent = t('viewer.changes', { n }); },
        onStep: (i, n) => { chgN.textContent = i + '/' + n; },
      }, file.path);
      head.appendChild(chg);
      body.appendChild(editor);
      return;
    }
    if (IMG_EXT.test(name)) {
      const img = document.createElement('img');
      img.className = 'imgview';
      img.src = 'file://' + file.path;
      body.appendChild(img);
      return;
    }
    if (PDF_EXT.test(name)) {
      // Chromium's built-in PDF viewer (no sandbox attr — it blocks the plugin)
      const fr = document.createElement('iframe');
      fr.className = 'htmlview';
      fr.src = 'file://' + file.path;
      body.appendChild(fr);
      return;
    }
    if (HTML_EXT.test(name)) {
      // operator's own exported deliverables — local, trusted, script-bearing
      const fr = document.createElement('iframe');
      fr.className = 'htmlview';
      fr.setAttribute('sandbox', 'allow-scripts');
      fr.src = 'file://' + file.path;
      body.appendChild(fr);
      return;
    }
    // markdown — Obsidian-style
    let src = file.content;
    let props = null;
    const fm = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (fm) {
      src = src.slice(fm[0].length);
      props = fm[1].split(/\r?\n/).filter((l) => /^[A-Za-z0-9_-]+:/.test(l)).slice(0, 8);
    }
    src = src.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_, target, alias) =>
      `<a class="wikilink" data-target="${target.trim().replace(/"/g, '&quot;')}">${(alias || target).trim()}</a>`);
    const wrap = document.createElement('div');
    wrap.className = 'mdview';
    if (props && props.length) {
      const pr = document.createElement('div');
      pr.className = 'mdprops';
      for (const line of props) {
        const chip = document.createElement('span');
        chip.className = 'mdprop';
        chip.textContent = line.trim();
        pr.appendChild(chip);
      }
      wrap.appendChild(pr);
    }
    const md = document.createElement('div');
    md.innerHTML = marked.parse(src); // operator's own vault content
    const dir = file.path.slice(0, file.path.lastIndexOf('/'));
    for (const img of md.querySelectorAll('img')) {
      const s = img.getAttribute('src') || '';
      if (s && !/^(https?|file|data):/.test(s)) img.src = 'file://' + dir + '/' + s;
    }
    // live task checkboxes — click toggles [ ]/[x] in the FILE (Obsidian-style)
    const boxes = md.querySelectorAll('input[type="checkbox"]');
    boxes.forEach((box, i) => {
      box.disabled = false;
      box.addEventListener('click', (e) => {
        e.stopPropagation();
        let n = -1;
        const updated = file.content.replace(/^(\s*(?:[-*+]|\d+\.)\s+\[)([ xX])(\])/gm, (m, a, mark, b) => {
          n++;
          return n === i ? a + (mark === ' ' ? 'x' : ' ') + b : m;
        });
        void save(updated, true);
      });
    });
    wrap.appendChild(md);
    wrap.addEventListener('click', async (e) => {
      const a = e.target.closest('a');
      if (!a) return;
      e.preventDefault();
      if (a.classList.contains('wikilink')) {
        const hit = await window.glassShell.resolveNote(a.dataset.target);
        if (hit) void openViewer(hit);
        else toast(t('viewer.noNote', { name: a.dataset.target }));
      }
    });
    body.appendChild(wrap);
  }

  paint();
  setActive(id);
}

/* ── explorer (git markers · live relist · auto-reveal · file icons · ctx menu) ─── */
const explorerEl = document.getElementById('explorer');
const EXPLORER = { icons: true, autoReveal: true };

/* file-type icon pack — colorful glyphs (ported from aios-glass), toggleable to plain */
const X_DOC = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>';
const xsv = (c, inner) => `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="${c}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const xbadge = (c, t) => `<svg viewBox="0 0 24 24" width="14" height="14"><rect x="2.5" y="4" width="19" height="16" rx="2.6" fill="none" stroke="${c}" stroke-width="1.7"/><text x="12" y="15.4" text-anchor="middle" font-family="-apple-system,Inter,sans-serif" font-size="8.3" font-weight="800" fill="${c}">${t}</text></svg>`;
const X_TERM = '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M7 9.5l3 2.5-3 2.5M13 14.5h4"/>';
const X_FAM = {
  md: () => xsv('#42a5f5', '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M6 15.5V9l3 3 3-3v6.5"/><path d="M16.5 9v4.4m0 0 1.8-1.8m-1.8 1.8-1.8-1.8"/>'),
  json: () => xsv('#d4a04a', '<path d="M8 4a3 3 0 0 0-3 3v2a2 2 0 0 1-2 2 2 2 0 0 1 2 2v2a3 3 0 0 0 3 3"/><path d="M16 4a3 3 0 0 1 3 3v2a2 2 0 0 0 2 2 2 2 0 0 0-2 2v2a3 3 0 0 1-3 3"/>'),
  node: () => xsv('#6cc24a', '<path d="M12 2.6 20 7v10l-8 4.4L4 17V7Z"/>'),
  ts: () => xbadge('#3178c6', 'TS'), js: () => xbadge('#caa92a', 'JS'), py: () => xbadge('#4b8bbe', 'PY'),
  shell: () => xsv('#4caf50', X_TERM), ps: () => xsv('#4aa3ff', X_TERM),
  html: () => xsv('#e8913a', '<polyline points="13 4 10 20"/><polyline points="7 8 3 12 7 16"/><polyline points="17 8 21 12 17 16"/>'),
  css: () => xsv('#4aa3ff', '<line x1="9" y1="4" x2="7.5" y2="20"/><line x1="16.5" y1="4" x2="15" y2="20"/><line x1="4" y1="9.5" x2="20" y2="9.5"/><line x1="3.4" y1="14.5" x2="19.4" y2="14.5"/>'),
  image: () => xsv('#c586ff', '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="m21 16-5-5L5 21"/>'),
  pdf: () => xsv('#e0524a', X_DOC),
  vsix: () => xsv('#41c4d8', '<path d="M14 4.6a1.5 1.5 0 0 0-3 0c0 .3.1.6.2.9H8.2a1 1 0 0 0-1 1v2.6c-.3-.1-.6-.2-.9-.2a1.5 1.5 0 0 0 0 3c.3 0 .6-.1.9-.2V18a1 1 0 0 0 1 1h2.6c-.1.3-.2.6-.2.9a1.5 1.5 0 0 0 3 0c0-.3-.1-.6-.2-.9H18a1 1 0 0 0 1-1v-3.1c.3.1.6.2.9.2a1.5 1.5 0 0 0 0-3c-.3 0-.6.1-.9.2V7.5a1 1 0 0 0-1-1h-3.1c.1-.3.2-.6.2-.9Z"/>'),
  archive: () => xsv('#b08968', '<rect x="2.5" y="4" width="19" height="4" rx="1"/><path d="M4.5 8v11a1 1 0 0 0 1 1h13a1 1 0 0 0 1-1V8"/><line x1="10" y1="12" x2="14" y2="12"/>'),
  git: () => xsv('#f05133', '<circle cx="6" cy="6" r="2.4"/><circle cx="6" cy="18" r="2.4"/><circle cx="18" cy="9" r="2.4"/><path d="M6 8.4v7.2M18 11.4a6 6 0 0 1-6 6H8.4"/>'),
  license: () => xsv('#a3a7ad', '<circle cx="12" cy="12" r="9"/><path d="M14.8 9.6a3.4 3.4 0 1 0 0 4.8"/>'),
  lock: () => xsv('#9aa0a6', '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
  canvas: () => xsv('#0099ff', '<rect x="3" y="4" width="7" height="6" rx="1"/><rect x="14" y="14" width="7" height="6" rx="1"/><path d="M10 7h4a2 2 0 0 1 2 2v5"/>'),
  doc: () => xsv('#8a8f98', X_DOC),
};
const X_ICON_FOR = { md: 'md', markdown: 'md', mdx: 'md', json: 'json', jsonc: 'json', yml: 'json', yaml: 'json', toml: 'json', node: 'node', ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', py: 'py', sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', ps1: 'ps', psm1: 'ps', html: 'html', htm: 'html', xml: 'html', vue: 'html', svelte: 'html', css: 'css', scss: 'css', sass: 'css', less: 'css', png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', svg: 'image', webp: 'image', ico: 'image', bmp: 'image', pdf: 'pdf', vsix: 'vsix', zip: 'archive', tar: 'archive', gz: 'archive', tgz: 'archive', '7z': 'archive', git: 'git', canvas: 'canvas', license: 'license', lock: 'lock' };
function xExtKey(name) {
  const n = name.toLowerCase();
  if (/^readme/.test(n)) return 'md';
  if (/^(license|copying)/.test(n)) return 'license';
  if (/(^|\.)(gitignore|gitattributes|gitmodules)$/.test(n)) return 'git';
  if (/^package(-lock)?\.json$/.test(n)) return 'node';
  if (/^tsconfig.*\.json$/.test(n)) return 'ts';
  if (/(\.lock)$/.test(n) || n === 'yarn.lock') return 'lock';
  return n.includes('.') ? n.split('.').pop() : '';
}
function fileIconSvg(name) { if (!EXPLORER.icons) return icon('file', 13); return (X_FAM[X_ICON_FOR[xExtKey(name)]] || X_FAM.doc)(); }

const dirContainers = new Map(); // absDir → the element holding its child rows (for in-place re-list)
const ensureExpand = new Map();  // path | 'sect:LABEL' → an expand-only fn (for auto-reveal)
const xFindRow = (p) => { for (const r of explorerEl.querySelectorAll('.xrow[data-path]')) if (r.dataset.path === p) return r; return null; };
const xSelect = (row) => { for (const r of explorerEl.querySelectorAll('.xrow.sel')) r.classList.remove('sel'); row.classList.add('sel'); };
const xQuote = (p) => /[^A-Za-z0-9._/\-]/.test(p) ? "'" + p.replace(/'/g, "'\\''") + "'" : p;

/* Every setup script the app runs ends with a framed verdict IN THE TERMINAL. A non-technical
   operator watching a wall of pip output has no way to know whether it finished, whether the red
   WARNING lines mattered, or that the next move is back in Setup. Silence at the end of a script
   reads as "it is still working" — which is exactly how a completed run got mistaken for a hang.

   The wording lives in a SCRIPT rather than inline in the command. Inlined, every terminal opened
   with a 700-character `printf '\n\033[32m%s…'` wall before anything ran: it worked, and it looked
   alarming enough that the operator asked for an alternative — and a newcomer deciding whether to
   trust this thing is reading that wall. Now the terminal shows the real command, recognisable,
   with one short tail. */
let BANNER = '';
async function bannerPath() {
  if (BANNER) return BANNER;
  try {
    BANNER = await window.glassShell.bannerScript({
      ok: t('term.doneOk'), okSub: t('term.doneOkSub'), fail: t('term.doneFail'), failSub: t('term.doneFailSub'),
    }) || '';
  } catch { BANNER = ''; }
  return BANNER;
}
async function withDoneBanner(cmd) {
  const b = await bannerPath();
  // no helper (write failed) → run the command plainly rather than not at all
  return b ? `{ ${cmd} ; }; ${xQuote(b)} $?` : cmd;
}
const xDirOf = (p) => p.slice(0, p.lastIndexOf('/')) || '/';

function openTerminalHere(p, isDir) {
  const dir = isDir ? p : xDirOf(p);
  void createPane({ name: dir.split('/').pop() || 'terminal', cwd: dir });
}
function sendPathToTerminal(p) {
  const id = active.term != null ? active.term : (active.main != null && panes.get(active.main)?.kind === 'term' ? active.main : null);
  if (id != null) { window.glassShell.ptyWrite(id, xQuote(p) + ' '); setActive(id); }
  else toast(t('ctx.openTerminalFirst'));
}

/* Drag a row out of the explorer. The data shape matches the Glass extension's (plain text
   + a file URI) so a drop onto the OS or another app behaves the same.
   Unlike Glass we can also handle the drop OURSELVES: Glass lives in a webview, and its own
   note says a webview→terminal drop cannot cross the iframe boundary, so it stops at
   dragstart and relies on right-click "send path". The app is one renderer with no such
   boundary, so the drop targets below actually work. */
function attachDrag(row, p, isDir) {
  row.draggable = true;
  row.addEventListener('dragstart', (ev) => {
    if (!ev.dataTransfer) return;
    ev.dataTransfer.setData('text/plain', p);
    ev.dataTransfer.setData('text/uri-list', 'file://' + encodeURI(p));
    ev.dataTransfer.setData('application/x-aios-path', p);   // our own, unambiguous
    // the row already KNOWS whether it is a folder — carrying it beats asking the main
    // process again on drop, and it cannot disagree with what the operator dragged
    if (isDir) ev.dataTransfer.setData('application/x-aios-dir', '1');
    ev.dataTransfer.effectAllowed = 'copy';
  });
}

/** Did the drop come from a FOLDER row? Unknown (an external drop) reads as a file. */
const draggedIsDir = (ev) => ev.dataTransfer?.getData('application/x-aios-dir') === '1';

/* Every path in a drop, ours or the OS's. An OS drag carries File objects whose real path
   needs webUtils: Electron REMOVED File.path in v32, so reading `file.path` (as the first
   cut did) silently yields nothing and a Finder drop looks broken rather than unsupported.
   Finder can also hand over SEVERAL files at once, which our own rows never do. */
function droppedPaths(ev) {
  const dt = ev.dataTransfer;
  if (!dt) return [];
  // ours first — unambiguous
  const own = dt.getData('application/x-aios-path');
  if (own) return [own];
  /* Then the File list, resolved through webUtils. This ORDER matters: a Finder drag also
     populates text/plain, and on macOS that is a `file://` URL rather than a path — so
     preferring text/plain (as the first cut did) handed a URL to the opener, which failed,
     and the File branch that actually works was never reached. */
  const files = [...(dt.files || [])].map((f) => window.glassShell.pathForFile(f)).filter(Boolean);
  if (files.length) return files;
  // Last resort: a URI list, which some sources give instead of File objects.
  const list = dt.getData('text/uri-list') || dt.getData('text/plain') || '';
  return list.split(/\r?\n/).map((u) => u.trim()).filter((u) => u && !u.startsWith('#'))
    .map((u) => (u.startsWith('file://') ? decodeURIComponent(u.slice('file://'.length)) : u));
}

/* While ANY drag is in flight, mark the body so the drop zones can announce themselves.
   Without this the affordance only appears once you are already over a target — which is
   too late to tell you where targets are. Driven at window level so an OS drag counts too. */
let dragDepth = 0;
const setDragging = (on) => {
  dragDepth = on ? dragDepth + 1 : Math.max(0, dragDepth - 1);
  document.body.classList.toggle('dragging', dragDepth > 0);
};
function paintDropHints() {
  const pz = document.getElementById('panes'), tz = document.getElementById('tpanes');
  if (pz) pz.dataset.drophint = t('drop.hintEditor');
  if (tz) tz.dataset.drophint = t('drop.hintTerminal');
}
paintDropHints();
const clearDragging = () => { dragDepth = 0; document.body.classList.remove('dragging'); };
/* A TAB DRAG IS NOT A FILE DRAG. This lights the editor + terminal drop zones for anything
   entering the window, which was right while every drag was a path from the explorer or
   Finder. Reordering a tab is now also a drag, and it made both zones offer themselves as
   drop targets for something they can never accept — the tab handlers refused it correctly,
   so the zones lit up and then did nothing, which reads as a broken drop rather than an
   invalid one.
   The type test has to read `types`, not getData(): during a drag the DataTransfer is in
   PROTECTED MODE and getData() returns '' by spec (see attachDropZone below, where testing
   getData() once broke dropping entirely). */
const isTabDrag = (ev) => [...(ev.dataTransfer?.types || [])].includes('application/x-aios-tab');
window.addEventListener('dragenter', (ev) => { if (!isTabDrag(ev)) setDragging(true); });
window.addEventListener('dragleave', (ev) => { if (!ev.relatedTarget) clearDragging(); });
/* `dragend` only fires on the element the drag STARTED from, so an external drag never
   produces one — for a Finder drop, `drop` is the only signal we get. And it has to be
   CAPTURE phase: the zone handlers call stopPropagation (so a drop on a terminal pane does
   not also run its zone's handler), which would otherwise stop this cleanup from ever
   running and leave the markers on screen after an external drop. */
window.addEventListener('dragend', clearDragging);
window.addEventListener('drop', clearDragging, true);

/** The dragged path, preferring our own type so a stray text drag can't be mistaken for one. */
function draggedPath(ev) {
  const dt = ev.dataTransfer;
  if (!dt) return '';
  return dt.getData('application/x-aios-path') || dt.getData('text/plain') || '';
}

/* Make a zone accept an explorer drop. `onPath` decides what the drop MEANS: the editor
   opens the file, a terminal inserts its path. Insert, never submit — a dropped path is the
   start of a command the operator is still writing, not a command. */
function attachDropZone(elm, onPath, opts = {}) {
  if (!elm) return;
  /* During dragover the DataTransfer is in PROTECTED MODE: `types` is readable but
     getData() returns '' — by spec, so a page can't snoop a drag it isn't receiving. So the
     accept test must read TYPES only. Testing getData() here meant ok() was false, we never
     called preventDefault, and the browser rejected the drop: the zone lit up (that comes
     from the window-level dragenter) but nothing ever happened when you released.
     My synthetic test missed it because a hand-made dataTransfer has no protected mode. */
  const DROP_TYPES = ['application/x-aios-path', 'text/uri-list', 'text/plain', 'Files'];
  const ok = (ev) => {
    const types = [...(ev.dataTransfer?.types || [])];
    // Explicit refusal, not refusal-by-omission: a tab reorder must never be read as a path,
    // even if a future change adds 'text/plain' to a tab's dataTransfer.
    if (types.includes('application/x-aios-tab')) return false;
    return types.some((tp) => DROP_TYPES.includes(tp));
  };
  elm.addEventListener('dragover', (ev) => {
    if (!ok(ev)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'copy';
    elm.classList.add('dropok');
  });
  elm.addEventListener('dragleave', (ev) => { if (ev.target === elm) elm.classList.remove('dropok'); });
  elm.addEventListener('drop', (ev) => {
    elm.classList.remove('dropok');
    clearDragging();   // also cleared in a window capture listener; harmless twice, fatal never
    const paths = droppedPaths(ev);
    if (!paths.length) return;
    ev.preventDefault(); ev.stopPropagation();
    void onPath(paths, draggedIsDir(ev), opts);
  });
}

/* right-click context menu — built once, reused */
let ctxEl = null, ctxTarget = null;
function ctxMenu() {
  if (ctxEl) return ctxEl;
  ctxEl = el('div', 'xctx'); ctxEl.hidden = true;
  const item = (label, fn) => { const b = el('button', '', label); b.addEventListener('click', () => { fn(ctxTarget); ctxEl.hidden = true; }); ctxEl.appendChild(b); };
  item(t('ctx.reveal'), (target) => window.glassShell.revealInOS(target.path));
  item(t('ctx.copyPath'), (target) => { window.glassShell.copyText(target.path); toast(t('ctx.pathCopied')); });
  item(t('ctx.openTerminalHere'), (target) => openTerminalHere(target.path, target.dir));
  item(t('ctx.sendPath'), (target) => sendPathToTerminal(target.path));
  document.body.appendChild(ctxEl);
  const hide = () => { ctxEl.hidden = true; };
  window.addEventListener('click', hide); window.addEventListener('blur', hide); window.addEventListener('scroll', hide, true);
  return ctxEl;
}
function attachCtx(row, path, dir) {
  row.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    const m = ctxMenu(); ctxTarget = { path, dir };
    m.hidden = false;
    // a click point is a zero-size rect — same zoom correction applies
    anchorMenu(m, { left: ev.clientX, bottom: ev.clientY, top: ev.clientY }, { gap: 2, width: 190 });
  });
}

/* AI-58: the neutral sort glyph (⇅ arrows) — mode-independent (a clock read as "loading") */
function sortGlyph() {
  return '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4v16M4 17l3 3 3-3"/><path d="M13.5 6h6M13.5 11h4.5M13.5 16h3"/></svg>';
}
/* the two-mode sort menu — built once, reused (same pattern as the ctx menu) */
let sortMenuEl = null, sortTarget = null;
function sortMenu() {
  if (sortMenuEl) return sortMenuEl;
  sortMenuEl = el('div', 'xctx'); sortMenuEl.hidden = true;
  const item = (mode, label) => {
    const b = el('button', '', label); b.dataset.mode = mode;
    b.addEventListener('click', () => { sortMenuEl.hidden = true; void applySort(sortTarget, mode); });
    sortMenuEl.appendChild(b);
  };
  item('name', t('sort.name'));
  item('mtime', t('sort.mtime'));
  document.body.appendChild(sortMenuEl);
  const hide = () => { sortMenuEl.hidden = true; };
  window.addEventListener('click', hide); window.addEventListener('blur', hide); window.addEventListener('scroll', hide, true);
  return sortMenuEl;
}
async function applySort(folder, mode) {
  if (!folder) return;
  const s = await window.glassShell.setSort(folder, mode);
  SORT.master = s.master === 'mtime' ? 'mtime' : 'name';
  SORT.overrides = s.overrides || {};
  // re-list the override's whole rendered subtree in the new order (no repaint)
  for (const d of [...dirContainers.keys()]) {
    if (d === folder || d.startsWith(folder + '/')) void relistFolder(d);
  }
}
/* hover-reveal per-folder sort control — on section headers, workspace roots, and any dir row */
function attachSortControl(rowEl, folderPath) {
  const sb = el('span', 'xsort');
  sb.title = t('sort.title');
  sb.innerHTML = sortGlyph();
  sb.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const m = sortMenu(); sortTarget = folderPath;
    const mode = resolveSortDir(folderPath); // current sort → shown in accent
    for (const b of m.querySelectorAll('button')) b.classList.toggle('on', b.dataset.mode === mode);
    m.hidden = false;
    anchorMenu(m, { left: ev.clientX, bottom: ev.clientY, top: ev.clientY }, { gap: 2, width: 190 });
  });
  rowEl.appendChild(sb);
}

/* Last known git state, kept so a row can be painted the moment it is created.
   Expanding a folder builds fresh rows; before this they waited for the next poll
   to get their markers — up to 4s of a folder looking clean when it wasn't. */
let GIT = { files: {}, dirty: new Set(), repos: [] };

function makeRow(e, depth, base) {
  const row = el('div', 'xrow' + (e.dir ? ' dir' : ''));
  row.dataset.path = e.path;
  row.style.paddingLeft = ((base || 14) + depth * 9) + 'px'; // Glass parity: 14px header base + 9px nesting
  const ic = el('span', 'xicon'); ic.innerHTML = e.dir ? icon('chevR', 11) : fileIconSvg(e.name);
  const nm = el('span', 'xname');
  const pm = e.dir ? e.name.match(/^(\d+ - )(.+)$/) : null;
  if (pm) { const pre = el('span', 'xpre'); pre.textContent = pm[1]; nm.append(pre, document.createTextNode(pm[2])); }
  else nm.textContent = e.dir ? e.name : e.name.replace(/\.md$/i, '');
  row.append(ic, nm);
  if (e.dir) attachSortControl(row, e.path); // per-folder sort on any subfolder, any depth (v2)
  paintRowGit(row); // from cache, so an expanded folder shows its state in the same frame
  attachCtx(row, e.path, e.dir);
  attachDrag(row, e.path, e.dir);
  if (e.dir) {
    let kids = null;
    const ensure = async () => {
      if (!kids) { kids = el('div', 'xkids'); row.after(kids); ic.innerHTML = icon('chevD', 11); await buildTree(e.path, kids, depth + 1, null, base); refreshGit(); }
      else if (kids.style.display === 'none') { kids.style.display = ''; ic.innerHTML = icon('chevD', 11); }
    };
    ensureExpand.set(e.path, ensure);
    row.addEventListener('click', async (ev) => {
      if (ev.altKey) { openTerminalHere(e.path, true); return; }
      xSelect(row);
      if (kids && kids.style.display !== 'none') { kids.style.display = 'none'; ic.innerHTML = icon('chevR', 11); }
      else await ensure();
    });
  } else {
    row.addEventListener('click', () => { xSelect(row); void openViewer(e.path); });
  }
  return row;
}

async function buildTree(absDir, container, depth, skipName, base) {
  container.dataset.depth = depth; container.dataset.base = (base || 14);
  if (skipName) container.dataset.skip = skipName; else delete container.dataset.skip;
  dirContainers.set(absDir, container);
  const entries = await sortedList(absDir);
  for (const e of entries) { if (skipName && e.name === skipName) continue; container.appendChild(makeRow(e, depth, base)); }
}

/* live git: reconcile status onto rendered rows (no re-expand) */
/* The ONE place a row's git marker is decided. Both the refresh pass and row
   creation call it, so a row painted at birth and a row painted by a refresh can
   never disagree — two copies of this logic would drift the first time one changed. */
function paintRowGit(row) {
  const p = row.dataset.path;
  if (!p) return;
  if (GIT.repos.length && !GIT.repos.some((r) => p === r || p.startsWith(r + '/'))) return;
  const isDir = row.classList.contains('dir');
  const code = GIT.files[p] || (isDir && GIT.dirty.has(p) ? 'M' : undefined);
  row.classList.remove('gM', 'gU', 'gA', 'gD', 'gR');
  const old = row.querySelector('.gst, .gdot'); if (old) old.remove();
  if (code) { row.classList.add('g' + code); row.append(isDir ? el('span', 'gdot') : el('span', 'gst', code)); }
}

function applyGit(files, dirtyList, repos) {
  GIT = { files: files || {}, dirty: new Set(dirtyList || []), repos: repos || [] };
  explorerEl.querySelectorAll('.xrow[data-path]').forEach(paintRowGit);
  applySectionGit(GIT.files);
}

/* Section-level rollup. Rows carry per-file state, but a collapsed FRAMEWORK or VAULT
   said nothing about pending work inside — you had to expand to find out. The header
   now carries the count for its own scope, with the per-state split in the tooltip. */
function applySectionGit(files) {
  const entries = Object.entries(files);
  explorerEl.querySelectorAll('.xsect[data-git-root]').forEach((head) => {
    const root = head.dataset.gitRoot, excl = head.dataset.gitExclude || '';
    const inRoot = (p) => p === root || p.startsWith(root + '/');
    const inExcl = (p) => !!excl && (p === excl || p.startsWith(excl + '/'));
    const tally = new Map();
    let n = 0;
    for (const [p, code] of entries) {
      if (!inRoot(p) || inExcl(p)) continue;
      tally.set(code, (tally.get(code) || 0) + 1); n++;
    }
    let badge = head.querySelector('.xsectgit');
    if (!n) { if (badge) badge.remove(); return; }
    if (!badge) {
      badge = el('span', 'xsectgit');
      const sort = head.querySelector('.xsort');
      if (sort) head.insertBefore(badge, sort); else head.appendChild(badge);   // interactive control stays rightmost
    }
    badge.textContent = String(n);
    const split = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(([c, k]) => c + ' ' + k).join(' · ');
    badge.title = t('explorer.gitPending', { n: String(n) }) + ' — ' + split;
  });
}
let gitTimer = null;
function refreshGit() {
  if (gitTimer) clearTimeout(gitTimer);
  gitTimer = setTimeout(() => { window.glassShell.fsGit().then((g) => applyGit(g.files, g.dirty, g.repos)).catch(() => {}); }, 120);
}

/* targeted in-place re-list of ONE folder (new files surface, removed vanish — no repaint).
   Re-places EVERY row in the sorted order (moving a row keeps its expanded .xkids block
   attached) — that's what makes a live sort-flip, or an mtime bump from a save, reorder. */
async function relistFolder(dir) {
  const container = dirContainers.get(dir);
  if (!container || container.offsetParent === null) return; // not rendered / collapsed
  const depth = +(container.dataset.depth || 0), base = +(container.dataset.base || 14), skipName = container.dataset.skip;
  const entries = (await sortedList(dir)).filter((e) => !(skipName && e.name === skipName));
  const want = new Set(entries.map((e) => e.path));
  const rowsNow = () => [...container.children].filter((n) => n.classList && n.classList.contains('xrow'));
  for (const r of rowsNow()) { if (!want.has(r.dataset.path)) { const k = r.nextElementSibling; if (k && k.classList.contains('xkids')) k.remove(); r.remove(); } }
  const byPath = new Map(rowsNow().map((r) => [r.dataset.path, r]));
  let anchor = null; // last placed node (a row, or its kids block)
  for (const e of entries) {
    const row = byPath.get(e.path) || makeRow(e, depth, base);
    const kids = (row.parentNode === container && row.nextElementSibling && row.nextElementSibling.classList.contains('xkids')) ? row.nextElementSibling : null;
    if (anchor) anchor.after(row); else container.prepend(row);
    if (kids) row.after(kids); // the expanded subtree travels with its folder row
    anchor = kids || row;
  }
}

/* auto-reveal: expand sections + ancestor folders down to a file, then select it */
async function revealPath(abs) {
  const roots = await window.glassShell.fsRoots();
  const places = [];
  if (roots.vault) places.push({ key: 'sect:VAULT', path: roots.vault });
  if (roots.framework && roots.framework !== roots.vault) places.push({ key: 'sect:FRAMEWORK', path: roots.framework });
  for (const w of roots.workspace) places.push({ key: 'sect:WORKSPACE', wpath: w.path, path: w.path });
  const place = places.find((p) => abs === p.path || abs.startsWith(p.path + '/'));
  if (!place) return;
  await ensureExpand.get(place.key)?.();
  if (place.wpath) await ensureExpand.get(place.wpath)?.();
  const parts = abs.slice(place.path.length + 1).split('/').filter(Boolean);
  let acc = place.path;
  for (let i = 0; i < parts.length - 1; i++) { acc += '/' + parts[i]; const fn = ensureExpand.get(acc); if (fn) await fn(); }
  const target = xFindRow(abs);
  if (target) { xSelect(target); target.scrollIntoView({ block: 'nearest' }); }
}

/* collapsible explorer sections — Framework · Vault · Workspace (state persisted) */
const explorerCollapsed = (() => { try { return new Set(JSON.parse(localStorage.getItem('explorerCollapsed') || '["FRAMEWORK"]')); } catch { return new Set(['FRAMEWORK']); } })();
function saveExplorerCollapsed() { try { localStorage.setItem('explorerCollapsed', JSON.stringify([...explorerCollapsed])); } catch { /* ignore */ } }

async function addSection(label, opts, buildBody) {
  const key = opts.key || label; // stable collapse-state key (locale-independent)
  const head = document.createElement('div');
  head.className = 'xsect xsecttoggle' + (opts.primary ? ' xprimary' : '') + (opts.external ? ' xext' : '');
  const car = document.createElement('span'); car.className = 'xcaret';
  head.appendChild(car);
  if (opts.dot) { const dot = document.createElement('span'); dot.className = 'xdot' + (opts.dot === 'ring' ? ' ring' : ''); head.appendChild(dot); }
  head.appendChild(el('span', 'xsectlab', label));
  if (opts.sub) head.appendChild(el('span', 'xsectsub', opts.sub));
  if (opts.gitRoot) {
    head.dataset.gitRoot = opts.gitRoot;
    // The vault lives INSIDE the framework root, and the framework tree skips it
    // (buildTree's skipName). The rollup must skip it too, or a vault-only edit
    // lights up FRAMEWORK and the marker lies about where the work is.
    if (opts.gitExclude) head.dataset.gitExclude = opts.gitExclude;
  }
  if (opts.sortRoot) attachSortControl(head, opts.sortRoot); // per-folder sort on Vault/Framework (v2)
  if (opts.add) {
    const addB = document.createElement('button'); addB.className = 'xadd'; addB.title = t('explorer.addFolder'); addB.textContent = '+';
    addB.addEventListener('click', (e) => { e.stopPropagation(); void opts.add(); });
    head.appendChild(addB);
  }
  const box = document.createElement('div'); box.className = 'xsectbody';
  let collapsed = explorerCollapsed.has(key);
  const apply = () => { car.innerHTML = icon(collapsed ? 'chevR' : 'chevD', 11); box.style.display = collapsed ? 'none' : ''; };
  head.addEventListener('click', () => {
    collapsed = !collapsed;
    if (collapsed) explorerCollapsed.add(key); else explorerCollapsed.delete(key);
    saveExplorerCollapsed(); apply();
  });
  ensureExpand.set('sect:' + key, () => { if (collapsed) { collapsed = false; explorerCollapsed.delete(key); saveExplorerCollapsed(); apply(); } });
  explorerEl.append(head, box);
  apply();
  await buildBody(box);
}

async function paintExplorer() {
  await SORT_READY; // the roamed sort prefs decide row order (resolved once, instant after boot)
  explorerEl.replaceChildren();
  dirContainers.clear(); ensureExpand.clear();
  const roots = await window.glassShell.fsRoots();
  if (roots.framework && roots.framework !== roots.vault) {
    await addSection(t('explorer.framework'), { key: 'FRAMEWORK', dot: 'ring', sub: t('explorer.frameworkSub'), sortRoot: roots.framework, gitRoot: roots.framework, gitExclude: roots.vault }, (box) => buildTree(roots.framework, box, 0, 'vault', 14));
  }
  if (roots.vault) {
    await addSection(t('explorer.vault'), { key: 'VAULT', dot: 'solid', sub: t('explorer.vaultSub'), primary: true, sortRoot: roots.vault, gitRoot: roots.vault }, (box) => buildTree(roots.vault, box, 0, null, 14));
  }
  await addSection(t('explorer.workspace'), { key: 'WORKSPACE', external: true, sub: t('explorer.workspaceSub'), add: async () => { const p = await window.glassShell.addFolder(); if (p) void paintExplorer(); } }, (box) => {
    for (const w of roots.workspace) {
      const fh = el('div', 'xrow dir xroot'); fh.dataset.path = w.path;
      fh.style.paddingLeft = '14px'; // match the Vault/Framework top-level folder indent (Glass parity)
      const ic = el('span', 'xicon'); ic.innerHTML = icon('chevR', 11);
      const nm = el('span', 'xname'); nm.textContent = w.name;
      const rm = el('span', 'xrm'); rm.title = t('explorer.removeFolder'); rm.textContent = '×';
      rm.addEventListener('click', async (e) => { e.stopPropagation(); await window.glassShell.removeFolder(w.path); void paintExplorer(); });
      fh.append(ic, nm);
      attachSortControl(fh, w.path); // hover-reveal per-folder sort — sits left of × (v2)
      fh.append(rm);
      box.appendChild(fh);
      attachCtx(fh, w.path, true);
      let kids = null;
      const ensure = async () => {
        if (!kids) { kids = el('div', 'xkids'); fh.after(kids); ic.innerHTML = icon('chevD', 11); await buildTree(w.path, kids, 0, null, 23); refreshGit(); }
        else if (kids.style.display === 'none') { kids.style.display = ''; ic.innerHTML = icon('chevD', 11); }
      };
      ensureExpand.set(w.path, ensure);
      fh.addEventListener('click', async (ev) => {
        if (ev.altKey) { openTerminalHere(w.path, true); return; }
        xSelect(fh);
        if (kids && kids.style.display !== 'none') { kids.style.display = 'none'; ic.innerHTML = icon('chevR', 11); }
        else await ensure();
      });
    }
    if (!roots.workspace.length) box.appendChild(el('div', 'xempty', t('explorer.empty')));
  });
  refreshGit();
}
void paintExplorer();

/* live: surface new/removed files in place + refresh git markers on any fs change */
window.glassShell.onFsEvent((m) => { for (const d of (m.dirs || [])) void relistFolder(d); refreshGit(); });
/* The framework or vault just appeared (or moved). The tree was built when neither existed, so it
   is not stale — it is empty, next to a vault full of files. Rebuild it rather than waiting for a
   file event inside roots we were never watching. */
window.glassShell.onRootsChanged(() => { void paintExplorer(); refreshGit(); });
setInterval(() => { if (!document.hidden) window.glassShell.fsGit().then((g) => applyGit(g.files, g.dirty, g.repos)).catch(() => {}); }, 4000);

/* ── rail: toggles + layout menu ──────────────────────────────────────────── */
document.getElementById('railMark').innerHTML = icon('aios', 22);
// the real AIOS mark, not a letter-A placeholder: empty state + window title bar (#30)
document.getElementById('emptyMark').innerHTML = icon('aios', 30);
document.getElementById('dragMark').innerHTML = icon('aios', 13);
// folder = the Files explorer; left-sidebar glyph = the Glass pulse panel
document.getElementById('railFind').innerHTML = icon('search', 15);
document.getElementById('railFind').addEventListener('click', () => void quickOpen());
document.getElementById('railExplorer').innerHTML = icon('folder', 15);
document.getElementById('railPlugins').innerHTML = icon('box', 15);
/* Rail tooltips — re-applied on locale change (paintRailTitles). */
function paintRailTitles() {
  document.getElementById('railMark').title = t('rail.aios');
  document.getElementById('railAgents').title = t('rail.agents');
  document.getElementById('railFind').title = t('rail.find');
  document.getElementById('railExplorer').title = t('rail.explorer');
  document.getElementById('railAdd').title = t('rail.add');
  document.getElementById('railDesigner').title = t('rail.designer');
  document.getElementById('railPlugins').title = t('rail.plugins');
  // #31 the ⌘⌥G chord family exists (full Glass parity) but was invisible — surface each
  // button's chord in its tooltip so the shortcuts are discoverable by hovering.
  const chord = (id, key) => { const b = document.getElementById(id); if (b) b.title += '   ⌘⌥G ' + key; };
  chord('railExplorer', 'B'); chord('railCompact', 'M'); chord('railAgents', 'G'); chord('railSettings', ',');
  document.getElementById('railCompact').title = t('rail.density');
  document.getElementById('railSetup').title = t('window.setup');
  document.getElementById('railLayout').title = t('rail.layout');
  document.getElementById('railSettings').title = t('rail.settings');
  document.getElementById('dragReadme').title = t('window.manual');
  document.getElementById('dragHelp').title = t('window.readme');
  document.getElementById('dragCheat').title = t('window.cheatsheet');
  document.getElementById('dragGuide').title = t('window.guide');
}
document.getElementById('railPlugins').addEventListener('click', () => openPluginsTab());
// go-with-agents (robot + live count badge), create-custom (+), and density (compact)
const railAgents = document.getElementById('railAgents');
railAgents.innerHTML = icon('robot', 16);
railAgents.appendChild(Object.assign(document.createElement('span'), { className: 'ribadge', hidden: true }));
railAgents.addEventListener('click', () => void pickSuggestion());
document.getElementById('railAdd').innerHTML = icon('plus', 16);
document.getElementById('railAdd').addEventListener('click', () => void createCustomFlow());
document.getElementById('railDesigner').addEventListener('click', () => openDesignerTab());
let COMPACT = false;
try { COMPACT = localStorage.getItem('compact') === '1'; } catch { /* ignore */ }
function applyCompact(on) {
  COMPACT = on;
  document.body.classList.toggle('compact', on);
  const b = document.getElementById('railCompact');
  b.innerHTML = icon(on ? 'compact' : 'comfort', 15);
  b.classList.toggle('on', on);
  try { localStorage.setItem('compact', on ? '1' : '0'); } catch { /* ignore */ }
}
document.getElementById('railCompact').addEventListener('click', () => applyCompact(!COMPACT));
applyCompact(COMPACT);
// framework update status — lives in the rail (was buried in the footer)
const railUpdate = document.getElementById('railUpdate');
/* Sidebar toggle — show/hide the Glass panel, in the title bar left of the layouts
   button. Not a collapse: a collapsed rail of icons looked worse than simply reclaiming
   the space. Mirrors the explorer's folder button exactly (a per-layout visibility flag,
   not a preset change), so hiding the panel leaves your layout and explorer untouched. */
const dragPanel = document.getElementById('dragPanel');
dragPanel.addEventListener('click', () => {
  if (!hasPanel()) { preset = lastPanelPreset; pOn = true; } else { pOn = !pOn; }  // from Zen, come back
  applyLayout();
});
// title-bar README + ? (help) buttons
const dragReadme = document.getElementById('dragReadme');
dragReadme.innerHTML = icon('book', 15);  // book → Operating Manual, opened in an in-app browser tab (#14)
dragReadme.addEventListener('click', () => openBrowserPane('https://www.the-aios.com/#manual', t('window.manual').split('—')[0].trim()));
const dragHelp = document.getElementById('dragHelp');
dragHelp.innerHTML = icon('file', 15);  // doc → README
dragHelp.addEventListener('click', () => openFrameworkDoc('README.md'));
const dragCheat = document.getElementById('dragCheat');
dragCheat.innerHTML = icon('help', 15);  // ?-in-a-circle → Cheatsheet (Glass parity)
dragCheat.addEventListener('click', () => openFrameworkDoc('CHEATSHEET.md'));
// The onboarding agent had no surface anywhere. It belongs beside the docs — a compass,
// not the robot glyph (that one means "go with agents" in the panel).
const dragGuide = document.getElementById('dragGuide');
dragGuide.innerHTML = icon('guide', 15);
dragGuide.addEventListener('click', () => void spawnNamed('onboarding-aios'));
/* Framework status — the Glass extension's quiet indicator: a colored dot + a short
   word in the panel header (NOT a boxed icon button), clickable to run the update when
   one is available, else to re-check. This is the single update surface; the old panel
   footer copy is gone. */
function updateRailStatus(state, fw) {
  const dot = railUpdate.querySelector('.pdot');
  const txt = railUpdate.querySelector('.pupdtext');
  railUpdate.classList.toggle('updok', state === 'up-to-date');
  railUpdate.classList.toggle('updavail', state === 'available');
  if (dot) dot.className = 'pdot ' + (state === 'available' ? 'st-warn' : state === 'up-to-date' ? 'st-ok' : 'st-idle');
  if (state === 'available') {
    if (txt) txt.textContent = t('pulse.updAvailable');
    railUpdate.title = t('rail.updateAvailable');
    railUpdate.onclick = () => pulse.cmd('aios.updateFramework');
  } else if (state === 'up-to-date') {
    if (txt) txt.textContent = t('pulse.updUpToDate');
    railUpdate.title = t('rail.updateUpToDate');
    railUpdate.onclick = () => pulse.send({ type: 'recheck' });
  } else if (fw && fw.synced) {
    if (txt) txt.textContent = t('pulse.updSynced', { date: fw.synced });
    railUpdate.title = t('rail.updateSynced', { synced: fw.synced, hash: fw.hash ? ' · ' + fw.hash.slice(0, 7) : '' });
    railUpdate.onclick = () => pulse.send({ type: 'recheck' });
  } else if (state === 'unknown') {
    /* There is nothing to compare against — no .aios-update tracker yet, which is the normal
       state of a vault that has never run /aios:update. This used to fall through to
       "Checking…" and sit there permanently, because the same branch served both "a check is in
       flight" and "there is nothing to check". A spinner that never resolves is a bug report
       waiting to happen; naming the state ends it. */
    if (txt) txt.textContent = t('pulse.updUntracked');
    railUpdate.title = t('rail.updateUntracked');
    railUpdate.onclick = () => pulse.send({ type: 'recheck' });
  } else {
    // genuinely in flight — the boot state, before the first answer arrives
    if (txt) txt.textContent = t('pulse.updChecking');
    railUpdate.title = t('rail.updateStatus');
    railUpdate.onclick = () => pulse.send({ type: 'recheck' });
  }
}
updateRailStatus('', null);
function updateAgentBadge(n) {
  const badge = railAgents.querySelector('.ribadge');
  if (!badge) return;
  badge.textContent = String(n || 0);
  badge.hidden = !n;
  railAgents.classList.toggle('hasbadge', !!n);
  // Glass parity: with nothing to route the button stays put but reads disabled —
  // a count when there's work, "none right now" when there isn't. Never appears/vanishes.
  railAgents.classList.toggle('disabled', !n);
  railAgents.title = n ? t('rail.agentsCount', { n }) : t('rail.agentsNone');
}
const railTheme = document.getElementById('railTheme');
let THEME = 'dark';
function paintThemeBtn() { railTheme.innerHTML = icon(THEME === 'light' ? 'moon' : 'sun', 15); railTheme.title = THEME === 'light' ? t('rail.themeDark') : t('rail.themeLight'); }
railTheme.addEventListener('click', async () => {
  THEME = THEME === 'light' ? 'dark' : 'light';
  await window.glassShell.setSetting('theme', THEME);
  applyTheme(THEME);
  paintThemeBtn();
});
/* Locale + theme init. The locale must be set before any tab renders, so the
   boot sequence (bottom of file) awaits initLocale() before opening the home
   tab. paintRailTitles() also runs here so tooltips are localized from frame 1. */
async function initLocale() {
  try {
    const c = await window.glassShell.shellConfig();
    THEME = c.theme || 'dark';
    // c.locale is the raw preference ('auto' | locale); c.localeResolved is what to render in.
    if (window.i18n) window.i18n.setLocale(c.localeResolved || c.locale || 'en');
  } catch { /* defaults: en + dark */ }
  applyStaticI18n();
  paintRailTitles();
  paintThemeBtn();
}
// Setup lives in the title bar now, as a wrench (installs/repairs); the Designer takes
// the rocket, which suits "build an agent" better than the old pen (#34).
document.getElementById('railSetup').innerHTML = icon('wrench', 15);
document.getElementById('railDesigner').innerHTML = icon('rocket', 15);
document.getElementById('railLayout').innerHTML = icon('layout', 15);
// The close-all broadcast, in the toolbar and hidden until ≥1 session runs (Glass
// closeAllTop parity).
const railCloseAll = document.getElementById('railCloseAll');
railCloseAll.innerHTML = icon('logout', 15);
railCloseAll.addEventListener('click', () => {
  const live = ((pulse.lastRunning || {}).running) || [];
  void closeAllSessions(live);
});
document.getElementById('railSettings').innerHTML = icon('gear', 15);
document.getElementById('railSetup').addEventListener('click', () => openSetupTab());
document.getElementById('railSettings').addEventListener('click', () => openSettingsTab());

// The folder button shows/hides the EXPLORER only — never the panel. (It used to flip the
// whole preset, so clicking it took the panel down with it.) From a panel-less layout it
// also returns you to Full, since that's the only place an explorer can show.
document.getElementById('railExplorer').addEventListener('click', () => {
  if (!hasExplorer()) { preset = lastPanelPreset; xOn = true; } else { xOn = !xOn; }  // from Zen, come back
  applyLayout();
});
// The panel is always visible (collapsing it made it hard to get back). The layout
// preset menu lives in the TITLE BAR (#36) — ⌘1–4 switch presets (native menu accelerators).
document.getElementById('railLayout').addEventListener('click', (e) => {
  e.stopPropagation();
  const menu = document.createElement('div');
  menu.className = 'lmenu';
  for (const name of LAYOUTS) {
    const b = document.createElement('button');
    const g = el('span', 'lglyph'); g.innerHTML = layoutGlyph(name);
    b.append(g, document.createTextNode(layoutLabel(name) + (name === preset ? '  ✓' : '')));
    b.classList.toggle('on', name === preset);
    b.addEventListener('click', () => {
      preset = name;
      if (hasPanel(name)) lastPanelPreset = name;   // remember it for the way back out of Zen
      applyLayout(); menu.remove();
    });
    menu.appendChild(b);
  }
  const sep = document.createElement('div'); sep.className = 'lsep'; menu.appendChild(sep);
  const sp = document.createElement('button');
  // the check goes on the RIGHT, exactly like a selected layout — terminals-below is on
  // by default, so it should read as "selected", not as a differently-marked option
  sp.textContent = t('layout.terminalsBelow') + (split ? '  ✓' : '');
  sp.addEventListener('click', () => { split = !split; applyLayout(); menu.remove(); });
  menu.appendChild(sp);
  document.body.appendChild(menu);
  anchorMenu(menu, document.getElementById('railLayout').getBoundingClientRect(), { gap: 6, width: 220 });
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
});

/* Zone-level drops, as fallbacks behind the per-pane handlers above:
   the editor zone OPENS what you drop (a folder reveals it in the explorer instead, since
   there is nothing to view), and the terminal zone routes to the active terminal — or opens
   one at that folder if none exists, which is the useful reading of "drop a folder here". */
attachDropZone(document.getElementById('panes'), async (paths, isDir) => {
  for (const dropped of paths) {
    // one of ours, and a folder: nothing to view, so reveal it in the tree
    if (isDir) { void revealPath(dropped); continue; }
    // An OS drop can be a folder too — that becomes a workspace folder, which is how an
    // outside project comes in.
    const addedDir = await window.glassShell.addFolderPath(dropped).catch(() => null);
    if (addedDir) { toast(t('drop.folderAdded', { name: addedDir.split('/').pop() })); void paintExplorer(); continue; }
    /* A file the reader refuses is simply outside every allowed root — which is most things
       dragged from Finder. Rather than dead-ending on "cannot open", bring its folder into
       scope: the same widening the Add-folder dialog performs, except the drop IS the
       consent, and the folder appears in the explorer where it can be removed again. */
    const readable = await window.glassShell.fsRead(dropped).catch(() => null);
    if (!readable) {
      const parent = xDirOf(dropped);
      const widened = await window.glassShell.addFolderPath(parent).catch(() => null);
      if (widened) { toast(t('drop.folderAdded', { name: parent.split('/').pop() })); void paintExplorer(); }
    }
    void openViewer(dropped);
  }
});
attachDropZone(document.getElementById('tpanes'), (paths, isDir) => {
  const id = active.term;
  if (id != null && panes.get(id) && !panes.get(id).exited) {
    // several files from Finder arrive as one drop — insert them all, space separated
    window.glassShell.ptyWrite(id, paths.map(xQuote).join(' ') + ' ');
    setActive(id);
    return;
  }
  // no terminal to receive it: opening one AT that folder is the useful reading
  const dir = isDir ? paths[0] : xDirOf(paths[0]);
  void createPane({ name: dir.split('/').pop() || 'terminal', cwd: dir });
});

/* ── splitters (drag to resize) ───────────────────────────────────────────── */
function dragX(el, apply) {
  el.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const move = (ev) => { apply(ev); fitTerms(); };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); saveLayout(); };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}
dragX(document.getElementById('xsplit'), (ev) => {
  const el = document.getElementById('xwrap');
  const r = el.getBoundingClientRect();
  // Facing docks the explorer RIGHT, so its width grows as the pointer moves left.
  const raw = explorerRight() ? r.right - ev.clientX : ev.clientX - r.left;
  xw = Math.max(150, Math.min(440, raw));
  el.style.width = xw + 'px';
});
dragX(document.getElementById('psplit'), (ev) => {
  const el = document.getElementById('panel');
  const r = el.getBoundingClientRect();
  // The maths is POSITION-based, so it is side-dependent: docked right, a dock's width
  // grows as the pointer moves LEFT. Same expression, mirrored.
  const raw = panelRight() ? r.right - ev.clientX : ev.clientX - r.left;
  pw = Math.max(PW_MIN, Math.min(PW_MAX, raw));
  el.style.width = pw + 'px';
});
dragX(document.getElementById('hsplit'), (ev) => {
  const wr = document.getElementById('work').getBoundingClientRect();
  th = Math.max(0.15, Math.min(0.8, (wr.bottom - ev.clientY) / wr.height));
  document.getElementById('termzone').style.height = Math.round(th * 100) + '%';
});

/* ── shell intents ────────────────────────────────────────────────────────── */
const byName = (name) => [...panes.entries()].find(([, p]) => p.kind === 'term' && p.name === name);

window.glassShell.onIntent(async (m) => {
  switch (m.kind) {
    case 'terminal':
      await createPane({ name: m.name || 'terminal', cmd: m.cmd });
      return;
    case 'spawnWorker': void spawnWorkerFlow(); return;
    case 'launchPrimary': { const c = await window.glassShell.shellConfig(); launchPrimary(c.primary || 'aios'); return; }
    case 'shortcuts': openShortcutsTab(); return;
    case 'openToday': { const d = new Date(); window.glassShell.panelSend({ type: 'openDay', date: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') }); return; }
    case 'designer': openDesignerTab(); return;
    case 'accountSwap': void accountSwapFlow(); return;
    case 'manual': openBrowserPane('https://www.the-aios.com/#manual', t('window.manual').split('—')[0].trim()); return;
    case 'readme': openFrameworkDoc('README.md'); return;
    case 'cheatsheet': openFrameworkDoc('CHEATSHEET.md'); return;
    case 'primary': void runInPrimary(m.slash); return;
    case 'focusTerminal':
    case 'focusByName': {
      const hit = byName(m.name);
      if (hit) setActive(hit[0]);
      else toast(`"${m.name ?? m.pid}" isn't a pane in this window`);
      return;
    }
    case 'closeByName': {
      const hit = byName(m.name);
      if (hit) closePane(hit[0]);
      return;
    }
    case 'closeTerminal':
      if (active.term !== null) closePane(active.term);
      else if (active.main !== null && panes.get(active.main)?.kind === 'term') closePane(active.main);
      return;
    case 'deadLetters': {
      /* A dead letter is a message that died. It gets a toast per item, because the failure
         mode being fixed is precisely that this was written down and never read. */
      for (const it of (m.items || []).slice(0, 3)) {
        toast(t('bus.deadLetter', { name: it.to }));
      }
      return;
    }
    case 'sendByName': {
      /* A `send` addresses a SESSION. Typing into a pane that merely still carries the name is
         how a brief ended up executing at a bash prompt. Report the outcome back so the bus can
         retire the request immediately instead of burning its release budget waiting for a
         verification that can never succeed. */
      const hit = byName(m.name);
      const p = hit ? panes.get(hit[0]) : null;
      if (!p || p.exited) { window.glassShell.busSendResult(m.name, false, 'no pane by that name in this surface'); return; }
      if (!p.isSession) { window.glassShell.busSendResult(m.name, false, 'that pane is no longer running the session (its Claude exited; it is a shell now)'); return; }
      submitToPty(hit[0], m.text);
      setActive(hit[0]);
      window.glassShell.busSendResult(m.name, true, '');
      return;
    }
    case 'escByName': {
      const hit = byName(m.name);
      if (hit) window.glassShell.ptyWrite(hit[0], '');
      return;
    }
    case 'ask': {
      const intent = await askWithChips();
      if (intent) {
        const slugged = ('ask-' + intent.toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, 28).replace(/-+$/, '');
        const prompt = `Find the right AIOS action for this intent and run it: "${intent}". Search my agents, /aios: commands, skills, and frequent tasks; pick the best match, tell me in one line which you chose and why, then execute it.`;
        // long prompts travel as a temp file, never typed into the pty (see task:handoff)
        const handed = await window.glassShell.taskHandoff(prompt, slugged).catch(() => prompt);
        await createPane({ name: slugged, cmd: `${CLAUDE} --name ${slugged} ${shq(handed)}` });
      }
      return;
    }
    case 'openFile':
      if (m.path) void openViewer(m.path);
      return;
    case 'toast':
      toast(m.text);
      return;
    case 'palette': void openPalette(); return;
    case 'quickOpen': void quickOpen(); return;
    case 'pickContext': void pickContext(m.ctxKind); return;
    /* Spawn a session whose NAME is the identity — CLAUDE.md globs agents/<bundle>/{name}.md, so
       a session called onboarding-aios becomes that agent rather than being told to run it. */
    case 'spawnNamed': void spawnNamed(String(m.name || ''), m.task ? String(m.task) : undefined); return;   // NOT m.kind — that is the envelope's own routing key
    case 'pickProject': void pickContext('projects'); return;
    case 'pickSuggestion': void pickSuggestion(); return;
    case 'pickDaily': void pickDaily(); return;
    case 'ingest': void ingestFlow(); return;
    case 'reportsFlow': void reportsFlow(); return;
    case 'pickAgent': void pickAgent(); return;
    case 'pickSkill': void pickSkill(); return;
    case 'pickCommand': void pickCommand(); return;
    case 'pickFrequent': void pickFrequent(); return;
    case 'pickRunning': void pickRunning(); return;
    case 'settings':
      openSettingsTab();
      return;
    case 'setup':
      openSetupTab();
      return;
    case 'plugins':
      openPluginsTab();
      return;
    case 'designer':
      openDesignerTab();
      return;
    case 'pluginsAddMarketplace':
      void addMarketplaceFlow();
      return;
    case 'home':
      openHomeTab();
      return;
    case 'layout':
      if (m.toggleSplit) split = !split;
      // remember which panel layout you came from, so Zen → back lands on IDE if that's
      // where you were (a hardcoded 'Full' silently demoted IDE users on every toggle)
      if (m.togglePanel) { if (!hasPanel()) { preset = lastPanelPreset; pOn = true; } else pOn = !pOn; }
      if (m.toggleExplorer) { if (!hasExplorer()) { preset = lastPanelPreset; xOn = true; } else { xOn = !xOn; } }
      // validate: the native menu once sent 'Full' long after it was renamed, and an
      // unknown value sailed straight through into the persisted layout
      if (m.preset && LAYOUTS.includes(m.preset)) {
        preset = m.preset;
        if (hasPanel(preset)) lastPanelPreset = preset;
      }
      applyLayout();
      return;
    case 'closeActive':
      if (active.main !== null) closePane(active.main);
      else if (active.term !== null) closePane(active.term);
      return;
  }
});

function shq(s) { return `'${s.replace(/'/g, `'\\''`)}'`; }


// The first prompt handed to a session launched with no explicit task — it triggers
// the Session Start Ritual (CLAUDE.md), exactly like the `spawn` wrapper's bootstrap.
const RITUAL_BOOTSTRAP = 'Start session';

/* Spawn a session whose NAME carries its identity. Everything that wants an agent to BE
   something (rather than to be asked about it) goes through here: --name sets
   CLAUDE_AGENT_NAME, which is what makes the session match agents/<bundle>/{name}.md on turn one.
   A named session is also separately closable, which a slash command in the primary is not. */
/* A ritual is a SESSION, not a terminal.
   Every one of these used to launch `claude '/aios:whatever'` with no --name. termEnv() derives
   CLAUDE_AGENT_NAME from the command's own --name, so without it the session skips CLAUDE.md's
   identity ritual entirely and never registers in ~/.claude/sessions — it shows up as an unnamed
   terminal, cannot be resumed, and does not appear in Running. Spotted on the update pill: "it
   shoots a session that is not recognised as a session".
   The pane already had a name for its tab; it just never reached Claude. One builder now emits
   both from the same string, so they cannot drift. */
const ritual = (name, slash) => ({ name, cmd: CLAUDE + ' --name ' + name + ' ' + shq(slash) });

function spawnNamed(name, task) {
  const handle = (name || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!handle) return;
  const hit = byName(handle);
  if (hit) { setActive(hit[0]); return; }   // already open — reveal, never duplicate
  /* ARGV, and the blocking screen is removed BEFORE launch rather than danced around.
     A positional prompt IS submitted when the session opens onto its composer (measured:
     `claude '/help'` renders the Help panel). What broke the handover is a session that must show
     a FIRST-RUN SCREEN first — the trust dialog, or an unfinished onboarding — which swallows the
     prompt and leaves an idle-looking session with the instruction gone. The operator's own
     diagnostic nailed it: ↑ then Enter brought it back, so it had been typed into a dialog.
     I tried watching the terminal for the composer instead and abandoned it: a regex against
     another product's UI, which read scrollback as current state and which I could not simulate
     faithfully enough to trust. Removing the screen is deterministic; guessing at it is not. */
  void createPane({ name: handle, cmd: CLAUDE + ' --name ' + handle + ' ' + shq(task || RITUAL_BOOTSTRAP) });
}



/* ── Shortcuts (#38): every binding in one readable sheet — ⌘/ or Help → Shortcuts.
   The chord family existed (Glass parity) but nothing showed it, so nobody could
   learn it. Grouped, with the chord prefix stated once. ─────────────────────── */
/* The app's keymap is its own — a standalone window needs none of the extension's
   ⌘⌥G chord prefix (that exists to dodge VS Code / Antigravity bindings). One rule,
   two rows: ⌘ opens a SURFACE · ⌘⇧ opens a PICKER. The old chords still work for
   muscle memory, but these are the canonical keys. */
const SHORTCUTS = [
  ['shortcuts.surfaces', [
    ['⌘K', 'shortcuts.palette'], ['⌘J', 'shortcuts.ask'], ['⌘P', 'shortcuts.quickOpen'],
    ['⌘N', 'shortcuts.session'], ['⌘T', 'shortcuts.terminal'], ['⌘R', 'shortcuts.resume'],
    ['⌘E', 'shortcuts.explorer'], ['⌘B', 'shortcuts.panel'], ['⌘W', 'shortcuts.closeTab'],
    ['⌘,', 'shortcuts.settings'], ['⌘1–4', 'shortcuts.layouts'], ['⌘0', 'shortcuts.terminalsBelow'],
    // NOT "this sheet": these same rows are rendered inline on Home, where "this" points at
    // the wrong thing. A label that names the artifact reads correctly in both places.
    ['⌘/', 'shortcuts.sheet'],
  ]],
  ['shortcuts.pickers', [
    ['⌘⇧F', 'shortcuts.frequent'], ['⌘⇧A', 'shortcuts.agent'], ['⌘⇧S', 'shortcuts.skill'],
    ['⌘⇧C', 'shortcuts.command'], ['⌘⇧I', 'shortcuts.ingest'], ['⌘⇧E', 'shortcuts.reports'],
    ['⌘⇧B', 'shortcuts.designer'], ['⌘⇧G', 'shortcuts.goAgents'], ['⌘⇧R', 'shortcuts.running'],
    ['⌘⇧P', 'shortcuts.projects'], ['⌘⇧X', 'shortcuts.context'], ['⌘⇧H', 'shortcuts.home'],
    ['⌘⇧Y', 'shortcuts.today'],
  ]],
];
function openShortcutsTab() {
  openToolTab('::shortcuts', t('shortcuts.title'), (body) => {
    const wrap = el('div', 'tool');
    body.appendChild(wrap);
    wrap.appendChild(el('div', 'tbig', t('shortcuts.title')));
    wrap.appendChild(el('div', 'tsub', t('shortcuts.sub')));
    for (const [groupKey, rows] of SHORTCUTS) {
      wrap.appendChild(el('div', 'ttitle', t(groupKey)));
      const grid = el('div', 'kgrid');
      for (const [keys, labelKey] of rows) {
        const r = el('div', 'krow');
        r.appendChild(el('kbd', '', keys));
        r.appendChild(el('span', 'klabel', t(labelKey)));
        grid.appendChild(r);
      }
      wrap.appendChild(grid);
    }
  });
}

/* ── Workspaces: args-as-forms (Glass spacesActions parity) ───────────────────
   The Companies / Collaboration buttons don't just run `--status`: they turn the
   command's subcommands into a guided picker, collect any argument (a company to
   sync, a remote to mount, a space name), then launch the REAL command. Glass
   triggers the engine; the command does the work. */
async function pickCompanyName(companies, title) {
  if (!companies.length) { toast(t('spaces.noCompanies')); return null; }
  return listModal(title, companies.map((c) => ({
    label: c.name, desc: [c.substrate, c.lastSync && t('spaces.synced', { when: c.lastSync })].filter(Boolean).join(' · '),
    icon: 'building', value: c.name,
  })), t('spaces.mountedCompanies'));
}
async function companyActionFlow(companies) {
  const action = await listModal(t('pulse.companies'), [
    { label: t('spaces.syncAll'), icon: 'sync', value: 'sync-all' },
    { label: t('spaces.syncOne'), icon: 'sync', value: 'sync' },
    { label: t('spaces.mount'), icon: 'download', value: 'mount' },
    { label: t('spaces.status'), icon: 'search', value: 'status' },
    { label: t('spaces.invite'), icon: 'users', value: 'invite' },
    { label: t('spaces.create'), icon: 'plus', value: 'create' },
  ], t('spaces.pickAction'));
  if (!action) return;
  const go = (args) => runWhere('/aios:company ' + args, 'company');
  if (action === 'sync-all') return go('--sync-all');
  if (action === 'status') return go('--status');
  if (action === 'create') return go('--create');
  if (action === 'mount') {
    const url = await inputModal(t('spaces.mountTitle'), t('spaces.mountPlaceholder'));
    if (url) return go('--mount ' + url.trim());
    return;
  }
  const name = await pickCompanyName(companies, action === 'sync' ? t('spaces.syncOne') : t('spaces.invite'));
  if (name) return go(`--${action} ${name}`);
}
async function collaborateActionFlow() {
  const action = await listModal(t('pulse.collaboration'), [
    { label: t('spaces.addProject'), icon: 'plus', value: 'add-project' },
    { label: t('spaces.status'), icon: 'search', value: 'status' },
    { label: t('spaces.newSpace'), icon: 'users', value: 'new' },
    { label: t('spaces.dryRun'), icon: 'check', value: 'dry-run' },
  ], t('spaces.pickAction'));
  if (!action) return;
  const go = (args) => runWhere('/aios:collaborate' + (args ? ' ' + args : ''), 'collaborate');
  if (action === 'new') {
    const name = await inputModal(t('spaces.newSpaceTitle'), t('spaces.newSpacePlaceholder'));
    if (name === null) return;              // cancelled — blank is a valid "let it suggest"
    return go(name.trim());
  }
  return go('--' + action);
}

/* #32 account rotation — pick from the USER.md roster; the swap itself is the
   framework's own claude-identity.sh (never reimplemented here). */
async function accountSwapFlow() {
  const list = await window.glassShell.accountsList().catch(() => []);
  if (!list.length) { toast(t('account.none')); return; }
  const pick = await listModal(t('account.title'), list.map((a) => ({
    label: a.email + (a.current ? '  ·  ' + t('account.current') : ''),
    desc: a.note, icon: a.current ? 'check' : 'id', value: a,
  })), t('account.placeholder'));
  if (!pick || pick.current) return;
  toast(t('account.swapping', { email: pick.email }));
  const r = await window.glassShell.accountsSwap(pick.email).catch(() => ({ ok: false, message: 'failed' }));
  toast(r.ok ? t('account.swapped', { email: pick.email }) : t('account.swapFailed', { message: r.message }));
}

/* ── Home: the human front door (greeting + big actions) ──────────────────── */
function openHomeTab() {
  openToolTab('::home', t('home.title'), async (body) => {
    const wrap = document.createElement('div');
    wrap.className = 'tool home';
    body.appendChild(wrap);
    const cfg = await window.glassShell.shellConfig();
    const h = new Date().getHours();
    const saludo = h < 12 ? t('home.morning') : h < 19 ? t('home.afternoon') : t('home.evening');
    // (settings + setup live in the title bar — Home stays a clean front door)
    const big = document.createElement('div'); big.className = 'tbig';
    // no name yet (fresh vault) → just the salute, never "Good morning, operator."
    const who = (cfg.operator || '').trim();
    big.textContent = who ? saludo + ', ' : saludo;
    if (who) { const nm = document.createElement('span'); nm.className = 'taccent'; nm.textContent = who; big.appendChild(nm); }
    big.appendChild(document.createTextNode('.'));
    const sub = document.createElement('div'); sub.className = 'tsub';
    sub.textContent = t('home.subtitle');
    wrap.append(big, sub);

    const grid = document.createElement('div'); grid.className = 'hgrid';
    const card = (emoji, title, hint, fn) => {
      const c = document.createElement('button'); c.className = 'hcard';
      const e = document.createElement('div'); e.className = 'hemoji'; e.innerHTML = icon(emoji, 22);
      const tt = document.createElement('div'); tt.className = 'htitle'; tt.textContent = title;
      const s2 = document.createElement('div'); s2.className = 'hhint'; s2.textContent = hint;
      c.append(e, tt, s2);
      c.addEventListener('click', fn);
      grid.appendChild(c);
    };
    const iso = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
    card('sun', t('home.planDay'), t('home.planDayHint'), async () => {
      // dual-use: open today's note if it already exists, else run /aios:today to create it
      const existing = await window.glassShell.resolveNote(iso());
      if (existing) window.glassShell.panelSend({ type: 'openDay', date: iso() });
      else void runWhere('/aios:today', 'today');
    });
    card('sparkles', t('home.ask'), t('home.askHint'), () => { window.glassShell.panelSend({ type: 'cmd', command: 'aios.askAios', args: [] }); });
    card('md', t('home.todayNote'), t('home.todayNoteHint'), () => { window.glassShell.panelSend({ type: 'openDay', date: iso() }); });
    card('moon', t('home.closeDay'), t('home.closeDayHint'), () => void createPane(ritual('close-day', '/aios:close-day')));
    wrap.appendChild(grid);

    // Shortcuts live on Home, not just behind ⌘/ — this is where a new operator looks,
    // and the app's keys are simple enough to learn at a glance.
    for (const [groupKey, rows] of SHORTCUTS) {
      wrap.appendChild(el('div', 'ttitle', t(groupKey)));
      const kg = el('div', 'kgrid');
      for (const [keys, labelKey] of rows) {
        const r = el('div', 'krow');
        r.appendChild(el('kbd', '', keys));
        r.appendChild(el('span', 'klabel', t(labelKey)));
        kg.appendChild(r);
      }
      wrap.appendChild(kg);
    }
    // (no "all shortcuts" link — Home renders the complete set; the same sheet is
    //  still reachable from Help → Keyboard shortcuts and ⌘/)
  });
}

/* ── tool tabs: Settings + Setup (synthetic viewer panes) ─────────────────── */
function openToolTab(key, titleText, build) {
  for (const [id, pane] of panes) {
    if (pane.kind === 'view' && pane.path === key) { setActive(id); return; }
  }
  const id = 'v' + (++viewSeq);
  const el = document.createElement('div');
  el.className = 'pane viewer';
  const head = document.createElement('div');
  head.className = 'vhead';
  const title = document.createElement('span'); title.className = 'vtitle'; title.textContent = titleText;
  head.appendChild(title);
  const body = document.createElement('div');
  body.className = 'vbody';
  el.append(head, body);
  const tab = makeTab(id, titleText, 'layout');
  const paneObj = { kind: 'view', name: titleText, el, tab, path: key };
  panes.set(id, paneObj);
  homePane(id, paneObj, { fresh: true });
  build(body, head);
  setActive(id);
}

function row(parent, label, control, hint) {
  const r = document.createElement('div');
  r.className = 'trow';
  const l = document.createElement('div'); l.className = 'tlabel'; l.textContent = label;
  if (hint) { const h = document.createElement('div'); h.className = 'thint'; h.textContent = hint; l.appendChild(h); }
  r.append(l, control);
  parent.appendChild(r);
  return r;
}

function openSettingsTab() {
  openToolTab('::settings', t('settings.title'), async (body) => {
    const wrap = document.createElement('div');
    wrap.className = 'tool';
    body.appendChild(wrap);
    const cfg = await window.glassShell.shellConfig();
    const vr = await window.glassShell.vaultRoot();

    // Setup's home is here, not permanent title-bar chrome: it's a "run the install
    // checks + repairs" surface you reach when something's wrong or on first run —
    // the Health card links to it too, and it stays in the app menu.
    const sh = document.createElement('div'); sh.className = 'ttitle'; sh.textContent = t('settings.setupSection'); wrap.appendChild(sh);
    const setupBtn = el('button', 'vbtn primary', t('settings.openSetup'));
    setupBtn.addEventListener('click', () => openSetupTab());
    row(wrap, t('settings.setupRow'), setupBtn, t('settings.setupHint'));

    const h = document.createElement('div'); h.className = 'ttitle'; h.textContent = t('settings.shell'); wrap.appendChild(h);

    // Search — filters every row and hides sections that end up empty. Sits directly
    // under the AIOS App heading, where the eye starts.
    const search = document.createElement('input');
    search.className = 'tinput tsearch'; search.type = 'search'; search.placeholder = t('settings.searchPlaceholder');
    wrap.appendChild(search);
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      let head = null, headHasMatch = false;
      const flushHead = () => { if (head) head.style.display = headHasMatch || !q ? '' : 'none'; };
      for (const child of [...wrap.children]) {
        if (child === search || child.classList.contains('tbig') || child.classList.contains('tsub')) continue;
        if (child.classList.contains('ttitle')) { flushHead(); head = child; headHasMatch = false; continue; }
        const hit = !q || (child.textContent || '').toLowerCase().includes(q);
        child.style.display = hit ? '' : 'none';
        if (hit) headHasMatch = true;
      }
      flushHead();
    });

    // Language — changing it re-localizes the whole UI live (no restart).
    // 'auto' follows the OS language; explicit choices override it.
    // ── Primary session name ── The single name behind the Launch button, runInPrimary
    // (every ritual), close-all's spare-the-primary rule, and the panel greeting's
    // fallback. It lives in USER.md's Identity table, which is where primaryName() reads
    // it from — so we write the same cell rather than shadowing it in shell.json, and
    // nothing can drift. Confirmed before writing (it renames a session identity), then
    // the panel is re-asked for state so every surface repaints with the new name.
    const primIn = document.createElement('input');
    primIn.className = 'tinput'; primIn.value = cfg.primary || '';
    primIn.placeholder = 'aios';
    primIn.addEventListener('change', async () => {
      const want = primIn.value.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
      const current = (cfg.primary || '').trim();
      if (!want || want === current) { primIn.value = current; return; }
      // same searchable/selectable picker as every other confirm in the app
      const ok = await listModal(t('settings.primaryConfirm', { from: current || 'aios', to: want }), [
        { label: t('settings.primaryConfirmYes'), desc: t('settings.primaryConfirmYesHint', { to: want }), icon: 'check', value: 'yes' },
        { label: t('settings.primaryConfirmNo'), desc: t('settings.primaryConfirmNoHint', { from: current || 'aios' }), icon: 'stop', value: 'no' },
      ], t('settings.primaryConfirmPlaceholder'));
      if (ok !== 'yes') { primIn.value = current; return; }
      const r = await window.glassShell.setPrimary(want).catch(() => ({ ok: false }));
      if (!r.ok) { primIn.value = current; toast(t('settings.primaryFailed')); return; }
      cfg.primary = r.name; primIn.value = r.name;
      pulse.send({ type: 'recheck' });   // PanelHost re-posts state → launch button + greeting repaint
      toast(t('settings.primarySaved', { name: r.name }));
    });
    row(wrap, t('settings.primaryName'), primIn, t('settings.primaryNameHint'));

    const langSel = document.createElement('select');
    langSel.className = 'tinput';
    const autoOpt = document.createElement('option'); autoOpt.textContent = t('settings.languageAuto'); autoOpt.value = 'auto'; langSel.appendChild(autoOpt);
    for (const m of (window.i18n ? window.i18n.localeMeta() : [{ code: 'en', nativeName: 'English' }])) {
      const o = document.createElement('option'); o.textContent = m.nativeName; o.value = m.code; langSel.appendChild(o);
    }
    langSel.value = cfg.locale || 'auto';          // the raw preference, not the resolved locale
    langSel.addEventListener('change', async () => {
      await window.glassShell.setSetting('locale', langSel.value);
      const c = await window.glassShell.shellConfig();  // re-read so 'auto' resolves to the OS language
      relocalize(c.localeResolved || 'en');             // re-render every open surface
      toast(t('settings.savedLanguage'));
    });
    row(wrap, t('settings.language'), langSel, t('settings.languageHint'));

    const mkToggle = (key, val) => {
      const t = document.createElement('input'); t.type = 'checkbox'; t.className = 'ttoggle'; t.checked = val;
      t.addEventListener('change', async () => { await window.glassShell.setSetting(key, t.checked); toast(window.i18n.t('settings.saved')); });
      return t;
    };
    const themeSel = document.createElement('select');
    themeSel.className = 'tinput';
    for (const [l, v] of [[t('settings.themeDark'), 'dark'], [t('settings.themeLight'), 'light']]) { const o = document.createElement('option'); o.textContent = l; o.value = v; themeSel.appendChild(o); }
    themeSel.value = cfg.theme || 'dark';
    themeSel.addEventListener('change', async () => { await window.glassShell.setSetting('theme', themeSel.value); applyTheme(themeSel.value); toast(t('settings.saved')); });
    row(wrap, t('settings.theme'), themeSel, t('settings.themeHint'));

    // killBehavior (Glass parity): what the session trash button does.
    const killSel = document.createElement('select');
    killSel.className = 'tinput';
    for (const [l, v] of [[t('killBehavior.ask'), 'ask'], [t('killBehavior.capture'), 'capture'], [t('killBehavior.kill'), 'kill']]) { const o = document.createElement('option'); o.textContent = l; o.value = v; killSel.appendChild(o); }
    killSel.value = cfg.killBehavior || 'ask';
    killSel.addEventListener('change', async () => { await window.glassShell.setSetting('killBehavior', killSel.value); KILLBEHAVIOR = killSel.value; toast(t('settings.saved')); });
    row(wrap, t('settings.killBehavior'), killSel, t('settings.killBehaviorHint'));

    // terminalMode (#6): where actions run — ask (pick among live sessions) or auto (primary/new)
    const modeSel = document.createElement('select');
    modeSel.className = 'tinput';
    for (const [l, v] of [[t('terminalMode.ask'), 'ask'], [t('terminalMode.auto'), 'auto']]) { const o = document.createElement('option'); o.textContent = l; o.value = v; modeSel.appendChild(o); }
    modeSel.value = cfg.terminalMode || 'ask';
    modeSel.addEventListener('change', async () => { await window.glassShell.setSetting('terminalMode', modeSel.value); toast(t('settings.saved')); });
    row(wrap, t('settings.terminalMode'), modeSel, t('settings.terminalModeHint'));

    const fontIn = document.createElement('input');
    fontIn.className = 'tinput'; fontIn.type = 'number'; fontIn.min = '10'; fontIn.max = '18'; fontIn.style.width = '70px';
    fontIn.value = String(cfg.termFontSize || 12.5);
    fontIn.addEventListener('change', async () => { await window.glassShell.setSetting('termFontSize', Number(fontIn.value) || 12.5); TERMFONT = Number(fontIn.value) || 12.5; toast(t('settings.savedNewTerminals')); });
    row(wrap, t('settings.termFont'), fontIn, t('settings.termFontHint'));

    // interface scale — the UI's counterpart to terminal font size, applied live
    const appFontIn = document.createElement('input');
    appFontIn.className = 'tinput'; appFontIn.type = 'number'; appFontIn.min = '10'; appFontIn.max = '18'; appFontIn.step = '0.5'; appFontIn.style.width = '70px';
    appFontIn.value = String(cfg.appFontSize || 13);
    appFontIn.addEventListener('change', async () => {
      const v = Math.min(18, Math.max(10, Number(appFontIn.value) || 13));
      appFontIn.value = String(v);
      await window.glassShell.setSetting('appFontSize', v);
      applyAppScale(v);
      toast(t('settings.saved'));
    });
    row(wrap, t('settings.appFont'), appFontIn, t('settings.appFontHint'));

    // ── Panel cards ── tick which cards the Glass panel shows. Hidden, not deleted:
    // order and contents survive a re-enable.
    // ONE row that opens the multi-select picker, rather than a stack of ten toggles.
    // "Needs you" is deliberately absent: it's the attention surface that appears when
    // something wants you, not a card you choose to show.
    const CARDS = [
      ['pDaily', 'pulse.daily'], ['pCal', 'pulse.calendar'], ['pQuick', 'pulse.quick'],
      ['pRun', 'pulse.running'], ['pAbout', 'pulse.aboutYou'], ['pSpaces', 'pulse.workspaces'],
      ['pLearn', 'pulse.claudeLearned'], ['pOut', 'pulse.recentOutputs'], ['pReports', 'pulse.reports'], ['pHealth', 'pulse.health'],
    ];
    const hiddenNow = new Set(cfg.hiddenCards || []);
    const cardsBtn = document.createElement('button');
    cardsBtn.className = 'tinput tpick';
    const paintCardsBtn = () => {
      const shown = CARDS.filter(([id]) => !hiddenNow.has(id)).length;
      cardsBtn.textContent = t('settings.panelCardsValue', { shown, total: CARDS.length });
    };
    paintCardsBtn();
    cardsBtn.addEventListener('click', async () => {
      const picked = await checkModal(t('settings.panelCards'), CARDS.map(([id, k]) => ({
        label: t(k), value: id, picked: !hiddenNow.has(id),
      })), { hint: t('settings.panelCardsHint'), confirmLabel: t('settings.panelCardsApply'), allowEmpty: true });
      if (!picked) return;
      const on = new Set(picked);
      hiddenNow.clear();
      for (const [id] of CARDS) if (!on.has(id)) hiddenNow.add(id);
      const list = [...hiddenNow];
      await window.glassShell.setSetting('hiddenCards', list);
      applyHiddenCards(list);
      paintCardsBtn();
      toast(t('settings.saved'));
    });
    row(wrap, t('settings.panelCards'), cardsBtn, t('settings.panelCardsRowHint'));

    row(wrap, t('settings.secondaryHints'), mkToggle('showHints', cfg.showHints), t('settings.secondaryHintsHint'));
    row(wrap, t('settings.ritualNudges'), mkToggle('showNudges', cfg.showNudges), t('settings.ritualNudgesHint'));
    row(wrap, t('settings.showMemory'), mkToggle('showMemory', cfg.showMemory !== false), t('settings.showMemoryHint'));

    // Calendar week numbers — repaints the calendar on the SETTING change (not just fs events)
    const wkToggle = document.createElement('input');
    wkToggle.type = 'checkbox'; wkToggle.className = 'ttoggle'; wkToggle.checked = cfg.showWeekNumbers !== false;
    wkToggle.addEventListener('change', async () => {
      await window.glassShell.setSetting('showWeekNumbers', wkToggle.checked);
      SHOWWK = wkToggle.checked;
      paintCalendar();
      toast(t('settings.saved'));
    });
    row(wrap, t('settings.weekNumbers'), wkToggle, t('settings.weekNumbersHint'));
    /* AIOS's own updates, not Claude's: this flips USER.md → ## Settings, which /today and
       /close-day read to decide whether to auto-pull when the vault is behind. It sat in the
       Claude section, which also stranded the three Claude flow buttons above it. */
    const auToggle = document.createElement('input');
    auToggle.type = 'checkbox'; auToggle.className = 'ttoggle';
    auToggle.checked = (await window.glassShell.claudeConfig().catch(() => ({ autoUpdates: true }))).autoUpdates;
    auToggle.addEventListener('change', async () => {
      await window.glassShell.setAutoUpdates(auToggle.checked);
      toast(t('settings.saved'));
    });
    row(wrap, t('settings.autoUpdates'), auToggle, t('settings.autoUpdatesHint'));

    // explorer settings — apply live (no restart)
    const exToggle = (key, val, after) => {
      const t = document.createElement('input'); t.type = 'checkbox'; t.className = 'ttoggle'; t.checked = val;
      t.addEventListener('change', async () => { await window.glassShell.setSetting(key, t.checked); after(t.checked); toast(window.i18n.t('settings.saved')); });
      return t;
    };
    const eh = document.createElement('div'); eh.className = 'ttitle'; eh.textContent = t('settings.explorer'); wrap.appendChild(eh);

    // "Open files in" (Glass cog parity): which mode a note opens in by default
    const openSel = document.createElement('select');
    openSel.className = 'tinput';
    for (const [l, v] of [[t('openNotesIn.rendered'), 'rendered'], [t('openNotesIn.source'), 'source']]) { const o = document.createElement('option'); o.textContent = l; o.value = v; openSel.appendChild(o); }
    openSel.value = cfg.openNotesIn || 'rendered';
    openSel.addEventListener('change', async () => { await window.glassShell.setSetting('openNotesIn', openSel.value); OPENNOTESIN = openSel.value; toast(t('settings.saved')); });
    row(wrap, t('settings.openNotesIn'), openSel, t('settings.openNotesInHint'));
    row(wrap, t('settings.showHidden'), exToggle('showHidden', cfg.showHidden, () => void paintExplorer()), t('settings.showHiddenHint'));
    row(wrap, t('settings.fileIcons'), exToggle('fileIcons', cfg.fileIcons !== false, (on) => { EXPLORER.icons = on; void paintExplorer(); }), t('settings.fileIconsHint'));
    row(wrap, t('settings.autoReveal'), exToggle('autoReveal', cfg.autoReveal !== false, (on) => { EXPLORER.autoReveal = on; }), t('settings.autoRevealHint'));

    // AI-58: the MASTER default sort — app-only operators have no VS Code settings UI,
    // so the global default lives here. Setting it clears every per-folder override.
    const sortSel = document.createElement('select');
    sortSel.className = 'tinput';
    for (const [l, v] of [[t('sort.name'), 'name'], [t('sort.mtime'), 'mtime']]) { const o = document.createElement('option'); o.textContent = l; o.value = v; sortSel.appendChild(o); }
    sortSel.value = SORT.master;
    sortSel.addEventListener('change', async () => {
      const s = await window.glassShell.setMasterSort(sortSel.value);
      SORT.master = s.master === 'mtime' ? 'mtime' : 'name';
      SORT.overrides = s.overrides || {};
      void paintExplorer(); // every folder re-lists under the new default
      toast(t('settings.saved'));
    });
    row(wrap, t('settings.sortDefault'), sortSel, t('settings.sortDefaultHint'));

    // Ignore patterns — folder/file names hidden from the tree AND skipped by git
    // status (no pending-commit bubble), e.g. _archive, _workspaces under ~/code.
    const ignoreIn = document.createElement('input');
    ignoreIn.className = 'tinput';
    ignoreIn.value = (cfg.ignorePaths || []).join(', ');
    ignoreIn.placeholder = '_archive, _workspaces';
    ignoreIn.addEventListener('change', async () => {
      const arr = ignoreIn.value.split(',').map((s) => s.trim()).filter(Boolean);
      await window.glassShell.setSetting('ignorePaths', arr);
      ignoreIn.value = arr.join(', ');                 // normalize what they see
      void paintExplorer();                            // hide/show folders live
      window.glassShell.fsGit().then((g) => applyGit(g.files, g.dirty, g.repos)).catch(() => {}); // clear/restore bubbles now
      toast(t('settings.saved'));
    });
    row(wrap, t('settings.ignorePaths'), ignoreIn, t('settings.ignorePathsHint'));

    const cc = await window.glassShell.claudeConfig();
    const h2 = document.createElement('div'); h2.className = 'ttitle'; h2.textContent = t('settings.claude'); wrap.appendChild(h2);
    // These are Claude's own settings, and this is a curated few of them — point at the
    // real list rather than pretending this is all of it.
    const h2s = el('div', 'tsub'); h2s.textContent = t('settings.claudeSub'); wrap.appendChild(h2s);

    /* Model list and permission modes come from the MAIN side, which merges our curated
       base with what Claude itself offers (that is where Fable lives) and honours the
       server gate that can switch bypassPermissions off. A list frozen in the renderer
       goes stale the moment Anthropic ships a model. */
    const MODELS = (await window.glassShell.modelOptions().catch(() => []))
      .map((m) => [m.label, m.value]);
    MODELS.push([t('settings.modelDefault'), '']);
    const MODES = await window.glassShell.permissionModes().catch(() => ['default']);

    const mkSelect = (options, value, key) => {
      const sel = document.createElement('select');
      sel.className = 'tinput';
      for (const o of options) {
        const opt = document.createElement('option');
        if (Array.isArray(o)) { opt.textContent = o[0]; opt.value = o[1]; } else { opt.textContent = o; opt.value = o; }
        sel.appendChild(opt);
      }
      sel.value = value;
      sel.addEventListener('change', async () => { await window.glassShell.claudeSet(key, sel.value); toast(t('settings.saved')); });
      return sel;
    };
    row(wrap, t('settings.model'), mkSelect(MODELS, cc.model, 'model'), t('settings.modelHint'));
    row(wrap, t('settings.permissionMode'), mkSelect(MODES, cc.mode, 'mode'), t('settings.permissionModeHint'));
    /* Claude's own output styles — built-ins plus anything under ~/.claude/output-styles/.
       Selecting the default DELETES the key rather than writing the string "default", so
       the setting keeps tracking Claude's default instead of pinning today's value. */
    const styles = await window.glassShell.outputStyles().catch(() => ['default']);
    if (cc.outputStyle && !styles.includes(cc.outputStyle)) styles.unshift(cc.outputStyle);
    row(wrap, t('settings.outputStyle'), mkSelect(styles, cc.outputStyle, 'outputStyle'), t('settings.outputStyleHint'));
    const mkCToggle = (key, val) => {
      const t = document.createElement('input'); t.type = 'checkbox'; t.className = 'ttoggle'; t.checked = val;
      t.addEventListener('change', async () => { await window.glassShell.claudeSet(key, t.checked); toast(window.i18n.t('settings.saved')); });
      return t;
    };
    row(wrap, t('settings.remoteControl'), mkCToggle('remoteControl', cc.remoteControl), t('settings.remoteControlHint'));
    row(wrap, t('settings.claudeInChrome'), mkCToggle('claudeInChrome', cc.claudeInChrome), t('settings.claudeInChromeHint'));
    row(wrap, t('settings.copyOnSelect'), mkCToggle('copyOnSelect', cc.copyOnSelect), t('settings.copyOnSelectHint'));
    row(wrap, t('settings.notify'), mkCToggle('agentPushNotif', cc.agentPushNotif), t('settings.notifyHint'));
    row(wrap, t('settings.awaySummary'), mkCToggle('awaySummary', cc.awaySummary), t('settings.awaySummaryHint'));
    row(wrap, t('settings.autoCompact'), mkCToggle('autoCompact', cc.autoCompact), t('settings.autoCompactHint'));
    row(wrap, t('settings.reduceMotion'), mkCToggle('reduceMotion', cc.reduceMotion), t('settings.reduceMotionHint'));
    row(wrap, t('settings.switchModels'), mkCToggle('switchModelsOnFlag', cc.switchModelsOnFlag), t('settings.switchModelsHint'));
    /* Claude's own configuration FLOWS — /goal, /fewer-permission-prompts, /schedule each
       open a session that walks you through one. They are actions rather than toggles, but
       they configure Claude, so they belong with Claude's settings; Advanced is for this
       app's plumbing and diagnostics, which is a different axis entirely. */
    const acts1 = document.createElement('div'); acts1.className = 'tacts';
    const mkBtn1 = (label, fn) => { const b = document.createElement('button'); b.className = 'vbtn'; b.textContent = label; b.addEventListener('click', fn); acts1.appendChild(b); };
    mkBtn1(t('settings.setGoal'), () => void createPane(ritual('goal', '/goal')));
    mkBtn1(t('settings.fewerPrompts'), () => void createPane(ritual('perms', '/fewer-permission-prompts')));
    mkBtn1(t('settings.scheduleWork'), () => void createPane(ritual('schedule', '/schedule')));
    wrap.appendChild(acts1);
    const h3 = document.createElement('div'); h3.className = 'ttitle'; h3.textContent = t('settings.account'); wrap.appendChild(h3);
    const acct = document.createElement('div'); acct.className = 'tpath'; acct.textContent = cc.account || t('settings.notSignedIn');
    row(wrap, t('settings.signedInAs'), acct, '');
    const acts = document.createElement('div'); acts.className = 'tacts';
    const mkBtn = (label, fn) => { const b = document.createElement('button'); b.className = 'vbtn'; b.textContent = label; b.addEventListener('click', fn); acts.appendChild(b); };
    // Swap account belongs HERE (Glass's cog has it) — rate limits are per account, so
    // rotation is a first-class setting, not just a menu item.
    mkBtn(t('settings.swapAccount'), () => void accountSwapFlow());
    mkBtn(t('settings.login'), () => void createPane({ name: 'login', cmd: CLAUDE + ' /login' }));
    mkBtn(t('settings.logout'), () => void createPane({ name: 'logout', cmd: CLAUDE + ' /logout' }));
    mkBtn(t('settings.updateFramework'), () => void createPane(ritual('update', '/aios:update')));
    wrap.appendChild(acts);

    // ── Advanced ── the power-user drawer: session/permission utilities, logs, and the
    // Claude CLI command. Nothing here is needed for normal operation.
    /* Advanced is collapsed by default: everything in it either changes Claude's global
       behaviour or repoints the app at another framework — real, but not what anyone
       opens Settings to do. State persists, so an operator who lives in here isn't made
       to re-open it every time. */
    const h4 = el('button', 'tfold'); h4.type = 'button';
    let advOpen = false;
    try { advOpen = localStorage.getItem('settingsAdvOpen') === '1'; } catch { /* default closed */ }
    const advBody = el('div', 'tfoldbody');
    const paintFold = () => {
      h4.innerHTML = icon(advOpen ? 'chevD' : 'chevR', 12) + '<span>' + t('settings.advanced') + '</span>';
      advBody.style.display = advOpen ? '' : 'none';
    };
    h4.addEventListener('click', () => {
      advOpen = !advOpen;
      try { localStorage.setItem('settingsAdvOpen', advOpen ? '1' : '0'); } catch { /* ignore */ }
      paintFold();
    });
    wrap.append(h4, advBody);
    paintFold();
    const wrapAdv = advBody;   // everything below lands inside the fold
    /* Advanced holds ONE kind of thing: this app's plumbing and its diagnostics — where
       the framework lives, which CLI binary to spawn, is the account healthy, where are
       the logs. Claude's own settings and flows live above, with the rest of Claude's. */
    const acts2 = document.createElement('div'); acts2.className = 'tacts';
    const mkBtn2 = (label, fn) => { const b = document.createElement('button'); b.className = 'vbtn'; b.textContent = label; b.addEventListener('click', fn); acts2.appendChild(b); };
    // Auth status + Show logs (both in Glass's cog): a read of the doctor's account
    // check, and the console where main + renderer logs land.
    mkBtn2(t('settings.authStatus'), async () => {
      const checks = await window.glassShell.setupCheck().catch(() => []);
      const a = (checks || []).find((c) => c.id === 'account');
      toast(a ? `${a.label}: ${a.message}` : t('settings.authUnknown'));
    });
    mkBtn2(t('settings.showLogs'), () => void window.glassShell.openDevTools());
    wrapAdv.appendChild(acts2);

    /* Where the framework lives. Editable rather than a printed path with "set an env var
       to override" — an operator who needs to move it cannot reach an env var from here.
       Empty falls back to GLASS_FRAMEWORK_PATH, then ~/aios; the row shows what actually
       resolved so a typo is visible immediately rather than as an empty app. */
    const fp = await window.glassShell.frameworkPath().catch(() => ({ value: '', resolved: '', source: 'default' }));
    const vpIn = document.createElement('input');
    vpIn.className = 'tinput';
    vpIn.value = fp.value;
    vpIn.placeholder = fp.resolved || '~/aios';
    vpIn.addEventListener('change', async () => {
      const next = await window.glassShell.setFrameworkPath(vpIn.value.trim()).catch(() => null);
      if (!next) return;
      toast(next.resolved ? t('settings.vaultSaved', { path: next.resolved }) : t('settings.vaultUnresolved'));
    });
    row(wrapAdv, t('settings.vault'), vpIn, t('settings.vaultHint', { resolved: fp.resolved || '—', source: fp.source }));

    // The Claude CLI command closes out Advanced. The Glass extension keeps it out of the
    // cog entirely (config-only) because an IDE terminal inherits your shell PATH, so
    // `claude` resolves on its own. This app spawns its OWN pty and has no other settings
    // surface, so when the CLI isn't on PATH — or you want a wrapper or a pinned version —
    // this row is what unbreaks it. Real, but advanced.
    const cmd = document.createElement('input');
    cmd.className = 'tinput'; cmd.value = cfg.claudeCmd;
    cmd.addEventListener('change', async () => { await window.glassShell.setSetting('claudeCmd', cmd.value.trim() || 'claude'); CLAUDE = cmd.value.trim() || 'claude'; toast(t('settings.savedNewSessions')); });
    row(wrapAdv, t('settings.claudeCmd'), cmd, t('settings.claudeCmdHint'));
  });
}

/* ── the Onboarding flow: sequenced zero-terminal onboarding stepper ────────────────
   Replaces the flat check list. Seven GATED steps, each verified by the doctor
   (Batch-D CheckResult shape): one primary button per step, running in a
   VISIBLE terminal (you see everything it does), an "Advanced" disclosure for
   the alternate lane, auto-advance on verified success. Idempotent by
   construction — re-opening re-VERIFIES; it never re-does a completed step. */
const onboardingFixPanes = new Set(); // pty ids of Onboarding fix terminals → re-verify on exit
let onboardingRepaint = null;         // live while the Setup tab is open

function openSetupTab() {
  openToolTab('::setup', t('setup.title'), (body, head) => {
    const wrap = el('div', 'tool onboarding');
    body.appendChild(wrap);

    const brand = el('div', 'tbrand');
    brand.innerHTML = '<div class="tbig">' + t('setup.welcome') + '</div><div class="tsub">' + t('setup.onboardingSub') + '</div>';
    wrap.appendChild(brand);
    const list = el('div', 'steps');
    wrap.appendChild(list);

    const recheck = el('button', 'vbtn', t('setup.recheck'));
    head.appendChild(recheck);

    let prevDone = null;   // step ids done on the previous paint → animate fresh completions once
    let painting = false;

    // every Onboarding fix runs where the operator can SEE it; the doctor re-verifies
    // when that terminal exits (and on the quiet poll below)
    /* The two-phase setup, stated as two buttons in order. Phase 1 is mechanical and the app
       owns it (there is no Claude session yet to delegate to). Phase 2 is a conversation, so
       a Claude session owns it via SETUP.md — which is written FOR a Claude session and
       carries judgment a script cannot: what to ask versus assume, what to defer, when to
       show a diff first. The handoff point is exactly "claude runs", which is why the second
       button only appears once it does. */
    /* One place that knows how to hand over. The brief tells the session where it was called
       from, which is what stops SETUP.md's step 1 from routing an app operator toward installing
       an IDE and the Glass extension — a surface they already have. */
    const spawnSetupSession = async () => {
      /* Trust the directory the session will open in, so no dialog stands between the operator's
         click and Claude reading the instruction. Narrow by design: their own vault, at the moment
         they ask for it. */
      const roots = await window.glassShell.fsRoots().catch(() => null);
      if (roots?.framework) await window.glassShell.trustDir(roots.framework).catch(() => {});
      return spawnNamed('aios-setup',
      /* No step COUNT in the prompt. It said "11-step"; canonical grew two necessary steps and
         became 13, and this line — in a different repo — went on saying 11 until a setup session
         noticed the mismatch and had to decide which to believe. The list is the source of truth
         and it counts itself. */
      'Set up my AI-OS from https://github.com/The-AIOS/aios — read its SETUP.md and follow the sequence in the "Reading this as Claude?" block. '
      + 'I reached you from the AIOS App, so the app is already my execution surface: do not send me to install an IDE or the Glass extension. '
      + 'Work through it with me interactively and finish by running /aios:today.');
    };


    /* Terminals are named for what the OPERATOR is doing, not for the check id that happens to
       drive them. "fix-account" and "fix-gh" describe our internals and call the normal first run
       of a product a "fix" — the operator asked what was broken. Nothing was. */
    const PANE_NAME = {
      phase1: 'install', account: 'claude-login', gh: 'github-login',
      git: 'install-git', claude: 'install-claude', 'first-project': 'first-project',
    };
    const fixPane = async (name, cmd) => {
      // bypassReady: these buttons exist precisely BECAUSE something is missing
      const pid = await createPane({ name: PANE_NAME[name] || name, cmd: await withDoneBanner(cmd), bypassReady: true });
      if (pid != null) onboardingFixPanes.add(pid);
    };
    const mkBtn = (parent, label, fn, { primary = false, title = '' } = {}) => {
      const b = el('button', 'vbtn' + (primary ? ' primary' : ''), label);
      if (title) b.title = title;
      b.addEventListener('click', fn);
      parent.appendChild(b);
      return b;
    };
    const cmdHint = (parent, cmd) => { if (cmd) parent.appendChild(el('div', 'step-cmd', '$ ' + cmd)); };

    /* quickstart-vs-advanced: ONE primary action per step; the alternate lane
       lives behind the "Advanced" disclosure. Buttons exist only on the ACTIVE
       step — gating is structural, not cosmetic. */
    function buildStepActions(s, acts, adv) {
      const by = (id) => s.checks.find((c) => c.id === id);
      switch (s.id) {
        case 'prereqs': {
          const git = by('git'), claude = by('claude'), node = by('node');
          /* "Install what I need" belongs HERE, in the box whose checks it satisfies. It used to
             float above the whole list, outside any step, which raised a fair question: is it a
             step or not? An operator with two plausible buttons and no stated relationship
             between them has to guess, and guessing is what this screen exists to remove.
             It is the primary action — one press covers Homebrew, the toolchain, Obsidian and
             Claude — so the per-tool buttons become the fallback for when it cannot. */
          mkBtn(acts, t('setup.phase1'), async () => {
            const script = await window.glassShell.phase1Script().catch(() => '');
            if (!script) { toast(t('setup.phase1Missing')); return; }
            void fixPane('phase1', `bash ${xQuote(script)}`);
          }, { primary: true, title: t('setup.phase1Hint') });
          /* The per-tool fixes live in ADVANCED, not beside the primary. Two buttons — one
             saying "install what I need", one naming a single tool — force a choice the operator
             has no basis for making, and the operator who hit it said exactly that. They remain
             reachable for the case where the one-shot script cannot do it.
             No "node is optional" note either: the script installs the whole toolchain, and
             telling someone a dependency is optional invites them to skip it and meet it later
             as a failure. */
          if (git && git.status !== 'pass') {
            mkBtn(adv, t('onboarding.installGit'), () => void fixPane('git', git.repairCmd || 'xcode-select --install'), { title: git.repairHint });
          }
          if (claude && claude.status !== 'pass') {
            // the check may be reporting "installed but off PATH", whose fix is not an install
            mkBtn(adv, claude.repairLabel || t('setup.installClaude'), () => void fixPane('claude', claude.repairCmd), { title: claude.repairHint });
          }
          void node;
          cmdHint(adv, git && git.repairHint);
          cmdHint(adv, claude && claude.repairHint);
          break;
        }
        case 'login': {
          const acct = by('account');
          mkBtn(acts, t('setup.login'), () => void fixPane('account', (acct && acct.repairCmd) || CLAUDE + ' /login'), { primary: true, title: acct && acct.repairHint });
          mkBtn(adv, t('onboarding.switchAccount'), () => void fixPane('account', CLAUDE + ' /logout && ' + CLAUDE + ' /login'));
          break;
        }
        case 'github': {
          const gh = by('gh');
          // primary drives gh's own device/web auth flow in a visible pane
          // (installs gh first when it's absent — the repairCmd knows which)
          mkBtn(acts, t('onboarding.connectGithub'), () => void fixPane('gh', (gh && gh.repairCmd) || 'gh auth login --web --git-protocol https'), { primary: true, title: gh && gh.repairHint });
          // advanced: the PAT lane — stored via git's credential helper, never echoed
          mkBtn(adv, t('onboarding.usePat'), async () => {
            const pat = await inputModal(t('onboarding.patTitle'), t('onboarding.patPlaceholder'), null, { password: true });
            if (!pat) return;
            const ok = await window.glassShell.onboardingStorePat(pat).catch(() => false);
            toast(ok ? t('onboarding.patStored') : t('onboarding.patFailed'));
            void paint();
          });
          adv.appendChild(el('div', 'step-note', t('onboarding.patHint')));
          break;
        }
        case 'firstrun': {
          /* The handover. This was "Plan my day" (`/aios:today`), which is the wrong last step:
             it produces a plan for a person the vault does not know yet — confidently, which is
             the problem — and it left the genuinely interactive work (wrappers, status line,
             hooks, the git remote, which MCPs, the cold-start interview, the orientation hat)
             with no home in the flow at all. That work needs judgment, so it belongs to a
             session, and the session ends by running /aios:today itself. So the final box IS
             the setup session, and this step's check verifies the RESULT rather than the click. */
          mkBtn(acts, t('setup.phase2'), () => spawnSetupSession(), { primary: true, title: t('setup.phase2Hint') });
          mkBtn(adv, t('onboarding.firstProject'), () => void fixPane('first-project', CLAUDE + ' ' + shq(t('onboarding.firstProjectPrompt'))));
          break;
        }
      }
    }

    function stepBody(s) {
      const bd = el('div', 'step-body');
      bd.appendChild(el('div', 'step-sub', t('onboarding.sub.' + s.id)));
      const rows = el('div', 'step-checks');
      for (const c of s.checks) {
        const r = el('div', 'srow');
        r.appendChild(el('span', 'phdot ' + (c.status === 'pass' ? 'st-ok' : c.status === 'warn' ? 'st-warn' : 'st-error')));
        r.appendChild(el('span', 'srlab', c.label + (s.optional.includes(c.id) ? ' · ' + t('onboarding.optional') : '')));
        const m = el('span', 'srmsg', c.message);
        m.title = c.message + (c.repairHint ? '\n→ ' + c.repairHint : '');
        r.appendChild(m);
        // the wiring step: one gated button per canonical script, on its own row
        if (s.id === 'wiring' && c.status !== 'pass' && (c.repairCmd || c.repairHint)) {
          const b = el('button', 'vbtn', t('health.fix'));
          b.title = c.repairCmd || c.repairHint;
          b.addEventListener('click', () => void fixPane(c.id, c.repairCmd || c.repairHint));
          r.appendChild(b);
        }
        rows.appendChild(r);
      }
      bd.appendChild(rows);
      const acts = el('div', 'step-acts');
      const adv = document.createElement('details'); adv.className = 'step-adv';
      const advSum = document.createElement('summary'); advSum.textContent = t('onboarding.advanced'); adv.appendChild(advSum);
      const advBody = el('div', 'step-advbody'); adv.appendChild(advBody);
      buildStepActions(s, acts, advBody);
      if (acts.childElementCount) bd.appendChild(acts);
      if (advBody.childElementCount) bd.appendChild(adv);
      return bd;
    }

    function stepEl(s, i) {
      const fresh = prevDone && s.done && !prevDone.has(s.id); // just flipped → announce once
      const box = el('div', 'step ' + s.state + (fresh ? ' just-done' : ''));
      const hd = el('div', 'step-head');
      hd.appendChild(el('span', 'step-ix', s.done ? '✓' : String(i + 1)));
      hd.appendChild(el('div', 'step-name', t('onboarding.step.' + s.id)));
      const summary = s.done ? (s.checks.find((c) => s.required.includes(c.id)) || {}).message || '' : '';
      if (summary) hd.appendChild(el('div', 'step-msg', summary));
      box.appendChild(hd);
      if (s.done) { hd.title = t('setup.recheck'); hd.addEventListener('click', () => void paint()); } // re-verify, never re-do
      if (s.state === 'active') box.appendChild(stepBody(s));
      return box;
    }

    function onboardingDoneEl() {
      // end signed-in and running: land on Home with the pulse live
      const d = el('div', 'onboarding-done');
      d.appendChild(el('div', 'tbig', t('onboarding.allDone')));
      d.appendChild(el('div', 'tsub', t('onboarding.allDoneSub')));
      const row2 = el('div', 'step-acts');
      const enter = el('button', 'vbtn primary', t('onboarding.enterAios'));
      enter.addEventListener('click', () => openHomeTab());
      row2.appendChild(enter);
      const deepen = el('button', 'vbtn', t('setup.deepenContext'));
      deepen.addEventListener('click', () => void createPane(ritual('cold-start', '/aios:cold-start-interview')));
      row2.appendChild(deepen);
      d.appendChild(row2);
      return d;
    }

    async function paint() {
      if (painting || !document.body.contains(wrap)) return;
      painting = true;
      let st = null;
      try { st = await window.glassShell.onboardingState(); } catch { st = null; } finally { painting = false; }
      if (!st || !document.body.contains(wrap)) return;
      list.replaceChildren();
      st.steps.forEach((s, i) => list.appendChild(stepEl(s, i)));
      if (st.current >= st.steps.length) list.appendChild(onboardingDoneEl());
      prevDone = new Set(st.steps.filter((s) => s.done).map((s) => s.id));
    }

    recheck.addEventListener('click', () => void paint());
    onboardingRepaint = paint;
    // quiet poll while the tab is open — device/web auth flows and long installs
    // complete OUTSIDE our terminals' exit events; the poll catches them
    const poll = setInterval(() => {
      if (!document.body.contains(wrap)) { clearInterval(poll); if (onboardingRepaint === paint) onboardingRepaint = null; return; }
      if (!document.hidden) void paint();
    }, 5000);
    void paint();
  });
}

/* ── Plugins & Marketplace (the AIOS Partner Network) ─────────────────────────
   Glass, not engine: we never reimplement `claude plugin`. We READ Claude Code's
   own plugin state and run the real CLI in a visible terminal. The catalog is the
   curated front shelf of the-aios.org/plugins — plugins, credentials, coaches. */
function openPluginsTab() {
  openToolTab('::plugins', t('plugins.title'), (body, head) => {
    const refresh = document.createElement('button'); refresh.className = 'vbtn'; refresh.textContent = t('plugins.refresh');
    head.appendChild(refresh);
    const wrap = document.createElement('div'); wrap.className = 'tool';
    body.appendChild(wrap);

    const brand = document.createElement('div'); brand.className = 'tbrand';
    brand.innerHTML = '<div class="tbig">' + t('plugins.partnerNetwork') + '</div>'
      + '<div class="tsub">' + t('plugins.partnerNetworkSub') + '</div>';
    wrap.appendChild(brand);

    const acts = document.createElement('div'); acts.className = 'tacts';
    const addB = document.createElement('button'); addB.className = 'vbtn'; addB.textContent = t('plugins.addMarketplace');
    addB.addEventListener('click', () => void addMarketplaceFlow());
    const onlineB = document.createElement('button'); onlineB.className = 'vbtn'; onlineB.textContent = t('plugins.openOnline');
    onlineB.addEventListener('click', () => void window.glassShell.openExternal('https://the-aios.org/plugins'));
    acts.append(addB, onlineB);
    wrap.appendChild(acts);

    const installedTitle = document.createElement('div'); installedTitle.className = 'ttitle'; installedTitle.textContent = t('plugins.installed');
    const installedList = document.createElement('div'); installedList.className = 'plug-list';
    const shelfTitle = document.createElement('div'); shelfTitle.className = 'ttitle'; shelfTitle.textContent = t('plugins.onTheShelf');
    const shelfList = document.createElement('div'); shelfList.className = 'plug-grid';
    wrap.append(installedTitle, installedList, shelfTitle, shelfList);

    async function paint() {
      const { catalog, installed, marketplaces } = await window.glassShell.aiosPlugins();
      const knownNames = marketplaces.map((m) => m.name);
      const installedIds = new Set(installed.map((p) => p.id));

      // Installed
      installedList.replaceChildren();
      if (!installed.length) {
        const e = document.createElement('div'); e.className = 'tsub'; e.textContent = t('plugins.noneInstalled');
        installedList.appendChild(e);
      }
      for (const p of installed) {
        const r = document.createElement('div'); r.className = 'plug-row';
        const main = document.createElement('div'); main.className = 'plug-rowmain';
        const nm = document.createElement('div'); nm.className = 'plug-rowname'; nm.textContent = p.name;
        const meta = document.createElement('div'); meta.className = 'plug-rowmeta';
        meta.textContent = '@' + p.marketplace + (p.version && p.version !== 'unknown' ? ' · v' + p.version : '');
        main.append(nm, meta);
        const upd = document.createElement('button'); upd.className = 'vbtn'; upd.textContent = t('plugins.update');
        upd.addEventListener('click', () => void createPane({ name: 'update-' + p.name, cmd: CLAUDE + ' plugin update ' + p.id }));
        r.append(main, upd);
        installedList.appendChild(r);
      }

      // Shelf (catalog)
      shelfList.replaceChildren();
      for (const p of catalog) {
        const card = document.createElement('div'); card.className = 'plug-card';
        const top = document.createElement('div'); top.className = 'plug-top';
        const nm = document.createElement('div'); nm.className = 'plug-name'; nm.textContent = p.displayName;
        const badge = document.createElement('span'); badge.className = 'plug-badge ' + p.badge.toLowerCase().replace(/[^a-z]+/g, '-'); badge.textContent = p.badge;
        top.append(nm, badge);
        const desc = document.createElement('div'); desc.className = 'plug-desc'; desc.textContent = p.description;
        const mkt = document.createElement('div'); mkt.className = 'plug-mkt'; mkt.textContent = p.marketplaceRepo;
        card.append(top, desc, mkt);

        const foot = document.createElement('div'); foot.className = 'plug-foot';
        if (installedIds.has(p.id)) {
          const tag = document.createElement('span'); tag.className = 'plug-installed'; tag.innerHTML = icon('check', 12) + ' ' + t('plugins.installedTag');
          foot.appendChild(tag);
        } else if (p.status === 'soon') {
          const tag = document.createElement('span'); tag.className = 'plug-soon'; tag.textContent = t('plugins.openingSoon');
          const become = document.createElement('button'); become.className = 'vbtn'; become.textContent = t('plugins.becomePartner');
          become.addEventListener('click', () => void window.glassShell.openExternal('https://the-aios.org/plugins'));
          foot.append(tag, become);
        } else {
          const install = document.createElement('button'); install.className = 'vbtn primary';
          install.innerHTML = icon('download', 12) + ' ' + t('plugins.install');
          install.addEventListener('click', () => {
            const known = knownNames.includes(p.marketplace);
            const add = `${CLAUDE} plugin marketplace add ${p.marketplaceRepo}`;
            const inst = `${CLAUDE} plugin install ${p.name}@${p.marketplace}`;
            void createPane({ name: 'install-' + p.name, cmd: known ? inst : `${add} && ${inst}` });
          });
          foot.appendChild(install);
        }
        card.appendChild(foot);
        shelfList.appendChild(card);
      }
    }
    refresh.addEventListener('click', () => void paint());
    void paint();
  });
}

async function addMarketplaceFlow() {
  const url = await inputModal(t('plugins.addMarketplaceTitle'), t('plugins.addMarketplacePlaceholder'));
  if (!url) return;
  void createPane({ name: 'add-marketplace', cmd: CLAUDE + ' plugin marketplace add ' + shq(url) });
}

/* ── list modal: the in-shell picker (fuzzy filter + Enter) ───────────────── */
/* Multi-select picker — the listModal family, with checkboxes + a confirm. Search,
   ↑↓ to move, Space toggles, Enter confirms, Esc cancels. Used by close-all (#16)
   and any other "pick several, then act" flow, so popups read the same everywhere.
   items: [{label, desc?, icon?, value, picked?, dot?}] → resolves an array of values
   (or null on cancel). */
function checkModal(title, items, { placeholder, hint, confirmLabel, allowEmpty } = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `<div class="modal"><div class="mtitle"></div><div class="msub"></div>
      <input id="checkInput" /><div class="plist"></div>
      <div class="mfoot"><span class="mhint"></span><button class="vbtn primary mgo"></button></div></div>`;
    wrap.querySelector('.mtitle').textContent = title;
    wrap.querySelector('.msub').textContent = hint || '';
    wrap.querySelector('.mhint').textContent = t('modal.checkHint');
    const go = wrap.querySelector('.mgo');
    const input = wrap.querySelector('#checkInput');
    input.placeholder = placeholder || t('modal.filterPlaceholder');
    const list = wrap.querySelector('.plist');
    const state = items.map((it) => ({ ...it, on: it.picked !== false }));
    let filtered = state, sel = 0;
    const done = (val) => { wrap.remove(); resolve(val); };
    const chosen = () => state.filter((s) => s.on).map((s) => s.value);
    // allowEmpty: for a "which of these do you want?" list, zero is a real answer
    // (hide every card); for close-all it isn't, so confirm stays disabled there.
    const paintGo = () => { const n = state.filter((s) => s.on).length; go.textContent = (confirmLabel || t('modal.confirm')) + (n ? ` (${n})` : ''); go.disabled = !n && !allowEmpty; };
    function paint() {
      list.replaceChildren();
      filtered.slice(0, 60).forEach((it, idx) => {
        const r = document.createElement('div');
        r.className = 'prow check' + (idx === sel ? ' on' : '');
        const bx = document.createElement('span'); bx.className = 'pcheck' + (it.on ? ' ticked' : '');
        bx.innerHTML = it.on ? icon('check', 11) : '';
        r.appendChild(bx);
        if (it.dot) { const d = document.createElement('span'); d.className = 'pindot ' + it.dot; r.appendChild(d); }
        const lb = document.createElement('span'); lb.className = 'plabel'; lb.textContent = it.label;
        r.appendChild(lb);
        if (it.desc) { const d = document.createElement('span'); d.className = 'pdesc'; d.textContent = it.desc; r.appendChild(d); }
        r.addEventListener('click', () => { it.on = !it.on; paint(); paintGo(); });
        r.addEventListener('mousemove', () => { if (sel !== idx) { sel = idx; paint(); } });
        list.appendChild(r);
      });
      const on = list.querySelector('.prow.on');
      if (on) on.scrollIntoView({ block: 'nearest' });
    }
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      filtered = q ? state.filter((it) => (it.label + ' ' + (it.desc || '')).toLowerCase().includes(q)) : state;
      sel = 0; paint();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, filtered.length - 1); paint(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); paint(); }
      else if (e.key === ' ') { e.preventDefault(); if (filtered[sel]) { filtered[sel].on = !filtered[sel].on; paint(); paintGo(); } }
      else if (e.key === 'Enter') { e.preventDefault(); if (state.some((s) => s.on) || allowEmpty) done(chosen()); }
      else if (e.key === 'Escape') { e.preventDefault(); done(null); }
    });
    go.addEventListener('click', () => { if (state.some((s) => s.on) || allowEmpty) done(chosen()); });
    wrap.addEventListener('click', (e) => { if (e.target === wrap) done(null); });
    document.body.appendChild(wrap);
    paint(); paintGo(); input.focus();
  });
}

/* items: [{label, desc?, icon?, value, action?}]
   `action` puts a button at the RIGHT of that row: { icon, title, run(item) }. A row action
   beats a separate "remove one…" row that opens a second list — the thing you want to act on
   is already under the pointer, which is how Glass's picker does it too. `run` returns true
   to keep the picker open and repaint (a delete), false to leave it alone. */
/* A yes/no gate for destructive actions. Enter confirms, Escape cancels, and the cancel
   button holds focus so an accidental Return does nothing. */
function confirmModal(title, message, confirmLabel) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `<div class="modal confirm"><div class="mtitle"></div>
      <div class="mbody"></div>
      <div class="macts"><button class="vbtn cancel"></button><button class="vbtn danger"></button></div></div>`;
    wrap.querySelector('.mtitle').textContent = title;
    wrap.querySelector('.mbody').textContent = message || '';
    const cancel = wrap.querySelector('.cancel');
    const ok = wrap.querySelector('.danger');
    cancel.textContent = t('modal.cancel');
    ok.textContent = confirmLabel || t('modal.confirm');
    const done = (v) => { wrap.remove(); document.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); done(true); }
    };
    cancel.addEventListener('click', () => done(false));
    ok.addEventListener('click', () => done(true));
    wrap.addEventListener('click', (e) => { if (e.target === wrap) done(false); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(wrap);
    cancel.focus();   // the safe option holds focus
  });
}

function listModal(title, items, placeholder) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `<div class="modal"><div class="mtitle"></div>
      <input id="pickInput" /><div class="plist"></div>
      <div class="mhint"></div></div>`;
    wrap.querySelector('.mhint').textContent = t('modal.navHint');
    wrap.querySelector('.mtitle').textContent = title;
    const input = wrap.querySelector('#pickInput');
    input.placeholder = placeholder || t('modal.filterPlaceholder');
    const list = wrap.querySelector('.plist');
    document.body.appendChild(wrap);
    let filtered = items;
    let sel = 0;
    const done = (val) => { wrap.remove(); resolve(val); };
    function paint() {
      list.replaceChildren();
      filtered.slice(0, 60).forEach((it, idx) => {
        const r = document.createElement('div');
        r.className = 'prow' + (idx === sel ? ' on' : '');
        const ic = document.createElement('span'); ic.className = 'picon'; ic.innerHTML = icon(it.icon || 'file', 12);
        const lb = document.createElement('span'); lb.className = 'plabel'; lb.textContent = it.label;
        r.append(ic, lb);
        if (it.desc) { const d = document.createElement('span'); d.className = 'pdesc'; d.textContent = it.desc; r.appendChild(d); }
        if (it.action) {
          const b = document.createElement('button');
          b.className = 'prowact'; b.type = 'button';
          b.innerHTML = icon(it.action.icon || 'trash', 12);
          b.title = it.action.title || '';
          b.addEventListener('click', async (ev) => {
            ev.stopPropagation();                 // the row's own click must not fire too
            const keepOpen = await it.action.run(it);
            if (!keepOpen) return;
            items = items.filter((x) => x !== it); // gone from the live list, no reopen needed
            filter();
          });
          r.appendChild(b);
        }
        r.addEventListener('click', () => done(it.value));
        r.addEventListener('mousemove', () => { if (sel !== idx) { sel = idx; paint(); } });
        list.appendChild(r);
      });
      const on = list.querySelector('.prow.on');
      if (on) on.scrollIntoView({ block: 'nearest' });
    }
    function filter() {
      const q = input.value.trim().toLowerCase();
      filtered = q ? items.filter((it) => (it.label + ' ' + (it.desc || '')).toLowerCase().includes(q)) : items;
      sel = 0;
      paint();
    }
    input.addEventListener('input', filter);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(sel + 1, filtered.length - 1); paint(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(sel - 1, 0); paint(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (filtered[sel]) done(filtered[sel].value); }
      else if (e.key === 'Escape') done(null);
    });
    wrap.addEventListener('click', (e) => { if (e.target === wrap) done(null); });
    paint();
    input.focus();
  });
}

/* ── pickers over the AIOS lists — every panel button becomes real ─────────── */
async function pickAgent() {
  const { agents } = await window.glassShell.aiosLists();
  const a = await listModal(t('pick.launchAgent'), agents.map((x) => ({ label: x.name, desc: x.group + (x.description ? ' · ' + x.description : ''), icon: 'md', value: x })), t('pick.launchAgentPlaceholder'));
  if (!a) return;
  const task = await inputModal(t('pick.wearHat', { name: a.name }), t('pick.taskOptional'));
  const arg = task ? a.name + ' — ' + task : a.name;
  void runWhere('/aios:agent ' + arg, a.name);
}
async function pickSkill() {
  const { skills } = await window.glassShell.aiosLists();
  const sk = await listModal(t('pick.loadSkill'), skills.map((x) => ({ label: x.name, desc: x.group + (x.description ? ' · ' + x.description.slice(0, 80) : ''), icon: 'html', value: x })), t('pick.loadSkillPlaceholder'));
  if (!sk) return;
  void runWhere('Use the ' + sk.name + ' skill.', sk.name);
}
async function pickCommand() {
  const { commands } = await window.glassShell.aiosLists();
  const c = await listModal(t('pick.runCommand'), commands.map((x) => ({ label: '/aios:' + x.name, desc: x.description.slice(0, 90), icon: 'term', value: x })), t('pick.runCommandPlaceholder'));
  if (!c) return;
  let slash = '/aios:' + c.name;
  if (c.argumentHint) {
    const arg = await inputModal('/aios:' + c.name, t('pick.argsOptional', { hint: c.argumentHint }));
    if (arg) slash += ' ' + arg;
  }
  void runWhere(slash, c.name);
}
async function pickFrequent() {
  const { frequent } = await window.glassShell.aiosLists();
  /* The list is shared with the Glass extension (same two keys in .glass/state.json), so
     what you add or delete here is there too. Manage rows live in the picker rather than in
     Settings: this is where you notice a task is missing or no longer useful. */
  const rows = frequent.map((x) => ({
    label: x.label, desc: x.hint, icon: 'layout', value: x,
    // a trash button on the row itself — the task you want gone is already under the pointer
    action: {
      icon: 'trash', title: t('freq.removeOne', { label: x.label }),
      run: async (item) => {
        const yes = await confirmModal(t('freq.removeConfirmTitle'), t('freq.removeConfirmBody', { label: item.label }), t('freq.removeConfirmOk'));
        if (!yes) return false;
        await window.glassShell.removeFrequent(item.value.id);
        toast(t('freq.removed', { label: item.label }));
        return true;    // drop it from the open picker rather than reopening
      },
    },
  }));
  rows.push({ label: t('freq.addTitle'), desc: t('freq.addHint'), icon: 'plus', value: { __add: true } });
  const task = await listModal(t('pick.frequentTasks'), rows, t('pick.frequentTasksPlaceholder'));
  if (!task) return;
  if (task.__add) { await addFrequentFlow(); return; }

  const a = (task.assignment || '').trim();
  if (task.kind === 'agent') void runWhere('/aios:agent ' + task.target + (a ? ' — ' + a : ''), task.target);
  else if (task.kind === 'command') void runWhere('/aios:' + task.target + (a ? ' ' + a : ''), task.target);
  else if (task.kind === 'skill') void runWhere('Use the ' + task.target + ' skill' + (a ? ': ' + a : '.'), task.target);
  else void runWhere(task.target, 'task');
}
/* Create a frequent task: name it, choose what runs it, pick the target from what is
   actually installed, then an optional standing instruction. Mirrors the extension's flow
   so the two produce identical entries — including the id shape. */
async function addFrequentFlow() {
  const label = await inputModal(t('freq.addTitle'), t('freq.addLabelPlaceholder'));
  if (!label || !label.trim()) return;
  const kind = await listModal(t('freq.addKindTitle'), [
    { label: t('freq.kindAgent'), desc: t('freq.kindAgentHint'), icon: 'robot', value: 'agent' },
    { label: t('freq.kindCommand'), desc: t('freq.kindCommandHint'), icon: 'command', value: 'command' },
    { label: t('freq.kindSkill'), desc: t('freq.kindSkillHint'), icon: 'skill', value: 'skill' },
    { label: t('freq.kindPrompt'), desc: t('freq.kindPromptHint'), icon: 'sparkles', value: 'prompt' },
  ], t('freq.addKindPlaceholder'));
  if (!kind) return;
  let target = '';
  if (kind === 'prompt') {
    // no target to pick — the instruction IS the task
    target = (await inputModal(label.trim(), t('freq.promptPlaceholder'))) || '';
    if (!target.trim()) return;
    await window.glassShell.addFrequent({ label: label.trim(), kind, target: target.trim() });
    toast(t('freq.added', { label: label.trim() }));
    return;
  }
  const L = await window.glassShell.aiosLists();
  const pool = kind === 'agent' ? (L.agents || []) : kind === 'command' ? (L.commands || []) : (L.skills || []);
  if (!pool.length) { toast(t('freq.noneInstalled')); return; }
  target = await listModal(t('freq.pickTarget'), pool.map((x) => ({
    label: x.name || String(x), desc: x.description || x.group || '', icon: kind === 'agent' ? 'robot' : kind === 'command' ? 'command' : 'skill', value: x.name || String(x),
  })), t('freq.pickTargetPlaceholder'));
  if (!target) return;
  const assignment = await inputModal(label.trim(), t('freq.assignmentPlaceholder'));
  await window.glassShell.addFrequent({ label: label.trim(), kind, target, assignment: (assignment || '').trim() || undefined });
  toast(t('freq.added', { label: label.trim() }));
}

async function pickRunning() {
  const { running } = await window.glassShell.aiosLists();
  const r = await listModal(t('pick.runningSessions'), running.map((x) => ({ label: x.name, desc: x.status, icon: 'term', value: x })), t('pick.runningSessionsPlaceholder'));
  if (!r) return;
  const hit = byName(r.name);
  if (hit) setActive(hit[0]);
  else toast(t('pick.runsOutside', { name: r.name }));
}

/* ── palette (⌘K): everything launchable, one list ─────────────────────────── */
async function openPalette() {
  const L = await window.glassShell.aiosLists();
  const items = [
    { label: t('palette.planDay'), desc: t('palette.planDayDesc'), icon: 'layout', value: { t: 'pane', ...ritual('today', '/aios:today') } },
    { label: t('palette.closeDay'), desc: t('palette.closeDayDesc'), icon: 'layout', value: { t: 'pane', ...ritual('close-day', '/aios:close-day') } },
    { label: t('palette.ask'), desc: t('palette.askDesc'), icon: 'layout', value: { t: 'ask' } },
    { label: t('palette.settings'), desc: t('palette.actionDesc'), icon: 'gear', value: { t: 'settings' } },
    { label: t('palette.setup'), desc: t('palette.actionDesc'), icon: 'rocket', value: { t: 'setup' } },
    { label: t('palette.plugins'), desc: t('palette.pluginsDesc'), icon: 'box', value: { t: 'plugins' } },
    { label: t('palette.designer'), desc: t('palette.designerDesc'), icon: 'design', value: { t: 'designer' } },
    ...L.running.map((x) => ({ label: x.name, desc: t('palette.sessionDesc', { status: x.status || t('palette.live') }), icon: 'term', value: { t: 'focus', name: x.name } })),
    ...L.frequent.map((x) => ({ label: x.label, desc: t('palette.taskDesc', { hint: x.hint }), icon: 'layout', value: { t: 'freq', task: x } })),
    ...L.agents.map((x) => ({ label: x.name, desc: t('palette.agentDesc', { group: x.group }) + (x.keywords ? ' · ' + x.keywords : ''), icon: 'md', value: { t: 'agent', name: x.name } })),
    ...L.commands.map((x) => ({ label: '/aios:' + x.name, desc: t('palette.commandDesc', { desc: x.description.slice(0, 70) }), icon: 'term', value: { t: 'cmd', c: x } })),
    ...L.skills.map((x) => ({ label: x.name, desc: t('palette.skillDesc', { group: x.group }), icon: 'html', value: { t: 'skill', name: x.name } })),
  ];
  const v = await listModal(t('palette.title'), items, t('palette.placeholder'));
  if (!v) return;
  if (v.t === 'pane') void createPane({ name: v.name, cmd: v.cmd });
  else if (v.t === 'ask') { const i = await askWithChips(); if (i) { const slug = ('ask-' + i.toLowerCase().replace(/[^a-z0-9]+/g, '-')).slice(0, 28).replace(/-+$/, ''); const p2 = 'Find the right AIOS action for this intent and run it: "' + i + '". Pick the best match, say which in one line, then execute.'; const h2 = await window.glassShell.taskHandoff(p2, slug).catch(() => p2); void createPane({ name: slug, cmd: CLAUDE + ' --name ' + slug + ' ' + shq(h2) }); } }
  else if (v.t === 'settings') openSettingsTab();
  else if (v.t === 'setup') openSetupTab();
  else if (v.t === 'plugins') openPluginsTab();
  else if (v.t === 'designer') openDesignerTab();
  else if (v.t === 'focus') { const hit = byName(v.name); if (hit) setActive(hit[0]); }
  else if (v.t === 'freq') runFrequent(v.task);
  else if (v.t === 'agent') { const task = await inputModal(t('pick.wearHat', { name: v.name }), t('pick.task')); void runWhere('/aios:agent ' + v.name + (task ? ' — ' + task : ''), v.name); }
  else if (v.t === 'cmd') { let slash = '/aios:' + v.c.name; if (v.c.argumentHint) { const a = await inputModal('/aios:' + v.c.name, v.c.argumentHint); if (a) slash += ' ' + a; } void runWhere(slash, v.c.name); }
  else if (v.t === 'skill') void runWhere('Use the ' + v.name + ' skill.', v.name);
}

const ADJS = ['amber', 'bold', 'calm', 'deft', 'eager', 'fleet', 'glad', 'keen', 'lucid', 'noble', 'quick', 'spry', 'vivid', 'warm', 'wise', 'zesty'];
const ANIMALS = ['otter', 'falcon', 'lynx', 'badger', 'heron', 'fox', 'orca', 'wren', 'ibex', 'puma', 'raven', 'seal', 'swift', 'tapir', 'viper', 'yak'];
function adjAnimal() {
  return ADJS[Math.floor(Math.random() * ADJS.length)] + '-' + ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
}
async function spawnWorkerFlow() {
  // Glass parity: ask for a name (blank → adjective-animal handle), then an
  // optional first task — exactly the extension's Spawn-a-session contract.
  const name = await inputModal(t('spawn.title'), t('spawn.namePlaceholder'));
  if (name === null) return;
  const handle = (name || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || adjAnimal();
  const task = await inputModal(t('spawn.sessionTitle', { handle }), t('spawn.firstTask'));
  if (task === null) return;
  // A bootstrap prompt is what makes the SESSION RITUAL run on turn one (identity →
  // agent match → context load). The spawn wrapper always passes one; a bare
  // `claude --name X` would sit idle and skip the ritual. No task → "Start session".
  void createPane({ name: handle, cmd: CLAUDE + ' --name ' + handle + ' ' + shq(task || RITUAL_BOOTSTRAP) });
}

/* Create a custom agent / skill / plugin — scaffolds into the right custom/ dir. */
async function createCustomFlow() {
  const kind = await listModal(t('create.title'), [
    { label: t('create.agent'), desc: t('create.agentDesc'), icon: 'md', value: 'agent' },
    { label: t('create.skill'), desc: t('create.skillDesc'), icon: 'html', value: 'skill' },
    { label: t('create.plugin'), desc: t('create.pluginDesc'), icon: 'box', value: 'plugin' },
  ], t('create.placeholder'));
  if (!kind) return;
  const what = await inputModal(t('create.new', { kind }), t('create.describe'));
  if (what === null) return;
  const dir = kind === 'plugin' ? 'plugins/custom/' : kind === 'agent' ? 'agents/custom/' : 'skills/custom/';
  const prompt = `Create a custom AIOS ${kind} for me${what ? ': ' + what : ''}. Scaffold the files under ${dir}, follow the framework conventions, register it where needed, and tell me in one line what you made and how to use it.`;
  void runWhere(prompt, 'create-' + kind);
}

/* ═══ Agent/Skill Designer — create + edit AIOS agents/skills without hand-writing
   markdown. TWO LANES: left a co-design chat (routes asks + the current draft to a
   live `claude` session named `designer`); right a structured editor with an
   Editor ⇄ Preview toggle. The preview IS the composed .md (frontmatter + body),
   exactly as saved. Save commits the file AND its custom/_index.md registry entry
   through the existing atomic fs:write IPC — composition lives in the main
   process (src/core/designer.ts), so what you preview is what lands on disk. ═══ */
const DZ_BODY_TPL = {
  agent: '## Purpose\n\n\n## When to invoke\n- \n\n## Instructions\n\n',
  skill: '## When to use\n- \n\n## Steps\n\n1. ',
};
/* Stacked field: label + hint ABOVE a full-width control (the settings row puts the
   control to the right, which is wrong for a form you actually type prose into). */
function fieldRow(parent, label, hint, control) {
  const f = el('div', 'dzfield');
  f.appendChild(el('div', 'dzlabel', label));
  f.appendChild(el('div', 'dzhint', hint || ''));   // always present — callers repaint it
  f.appendChild(control);
  parent.appendChild(f);
  return f;
}

function openDesignerTab() {
  openToolTab('::designer', t('designer.title'), (body) => {
    const wrap = el('div', 'tool');
    body.appendChild(wrap);
    const st = { mode: 'create', kind: 'agent', targetPath: '' };

    wrap.appendChild(el('div', 'tbig', t('designer.title')));
    wrap.appendChild(el('div', 'tsub', t('designer.sub')));

    // ── 1. create or update ──
    const modes = el('div', 'dzkinds');
    const mkMode = (m, label) => {
      const b = el('button', 'dzkind', label); b.dataset.mode = m;
      b.addEventListener('click', () => { st.mode = m; st.targetPath = ''; paintAll(); });
      modes.appendChild(b);
    };
    mkMode('create', t('designer.modeCreate'));
    mkMode('update', t('designer.modeUpdate'));
    wrap.append(el('div', 'ttitle', t('designer.step1')), modes);

    // ── 2. which kind ──
    const kindTitle = el('div', 'ttitle', t('designer.step2'));
    const kinds = el('div', 'dzkinds');
    const about = el('div', 'dzabout');
    const home = el('div', 'dzhome');
    for (const k of ['agent', 'skill', 'command']) {
      const b = el('button', 'dzkind', t('designer.kind.' + k)); b.dataset.kind = k;
      b.addEventListener('click', () => { st.kind = k; st.targetPath = ''; paintAll(); });
      kinds.appendChild(b);
    }
    const pickMine = el('button', 'vbtn dzpick');
    pickMine.addEventListener('click', async () => {
      const list = (await window.glassShell.designerCatalog(st.kind).catch(() => [])).filter((x) => x.custom);
      if (!list.length) { toast(t('designer.noneOfYours', { kind: t('designer.kind.' + st.kind) })); return; }
      const pick = await listModal(t('designer.pickMine'), list.map((x) => ({
        label: x.name, desc: x.description ? x.description.slice(0, 90) : x.path, icon: 'file', value: x,
      })), t('designer.pickMinePlaceholder'));
      if (!pick) return;
      st.targetPath = pick.path;
      nameIn.value = pick.name;
      descIn.value = pick.description || '';
      // pull the real body out of the file so Instructions starts from what's THERE —
      // the catalog only carries name + description
      const cur = await window.glassShell.designerRead(pick.path).catch(() => null);
      if (cur) {
        if (cur.description && !descIn.value.trim()) descIn.value = cur.description;
        if (cur.body) bodyTa.value = cur.body;
      }
      paintAll();
    });
    wrap.append(kindTitle, kinds, about, home, pickMine);

    // ── 3. the brief: who · what · how ──
    // "Tell the builder" heading carries the Clear action on its right — it only appears
    // once there's something to clear, so an empty form has no destructive affordance.
    const step3 = el('div', 'ttitle dzstep3', t('designer.step3'));
    const clear = el('button', 'dzclear', t('designer.clear'));
    clear.addEventListener('click', () => {
      st.mode = 'create'; st.kind = 'agent'; st.targetPath = '';
      nameIn.value = ''; descIn.value = ''; bodyTa.value = '';
      paintAll();
    });
    step3.appendChild(clear);
    wrap.appendChild(step3);
    // labels, hints and placeholders are PER KIND — "who is it?" fits an agent, not a
    // skill or a plugin; they repaint whenever the kind changes (see paintFields).
    const nameIn = document.createElement('input'); nameIn.className = 'tinput dzwide';
    const nameF = fieldRow(wrap, '', '', nameIn);
    const descIn = document.createElement('input'); descIn.className = 'tinput dzwide';
    const descF = fieldRow(wrap, '', '', descIn);
    const bodyTa = document.createElement('textarea'); bodyTa.className = 'tinput dzbody'; bodyTa.rows = 9;
    const bodyF = fieldRow(wrap, '', '', bodyTa);
    const paintFields = () => {
      const k = st.kind;
      for (const [f, input, base] of [[nameF, nameIn, 'name'], [descF, descIn, 'desc'], [bodyF, bodyTa, 'body']]) {
        f.querySelector('.dzlabel').textContent = t(`designer.${base}.${k}`);
        f.querySelector('.dzhint').textContent = t(`designer.${base}Hint.${k}`);
        input.placeholder = t(`designer.${base}Placeholder.${k}`);
      }
    };
    for (const inp of [nameIn, descIn, bodyTa]) inp.addEventListener('input', () => paintGo());

    // ── hand off ──
    const go = el('button', 'vbtn primary dzgo');
    const goHint = el('div', 'dzgohint');
    go.addEventListener('click', async () => {
      const fields = { name: nameIn.value.trim(), description: descIn.value.trim(), keywords: '', tier: 'judgment', body: bodyTa.value.trim() };
      // The brief goes to a TEMP FILE and the session gets one short line to read it —
      // the same indirection the spawn wrapper and the command bus use. Typing a long
      // multi-line brief into the pty mangled the shell quoting and truncated it.
      const h = await window.glassShell.designerHandoff({ kind: st.kind, fields, mode: st.mode, targetPath: st.targetPath || undefined }).catch(() => null);
      if (!h) { toast(t('designer.needName')); return; }
      void createPane({ name: 'aios-builder', cmd: CLAUDE + ' --name aios-builder ' + shq('/aios:agent aios-builder — ' + h.prompt) });
      toast(t('designer.handedOff'));
    });
    wrap.append(go, goHint);

    function paintGo() {
      const named = !!nameIn.value.trim();
      const said = !!bodyTa.value.trim();
      const targeted = st.mode === 'create' || !!st.targetPath;
      go.textContent = st.mode === 'update'
        ? t('designer.updateWithBuilder', { kind: t('designer.kind.' + st.kind) })
        : t('designer.createWithBuilder', { kind: t('designer.kind.' + st.kind) });
      go.disabled = !named || !said || !targeted;
      clear.hidden = !(nameIn.value.trim() || descIn.value.trim() || bodyTa.value.trim() || st.targetPath);
      goHint.textContent = !targeted ? t('designer.needTarget', { kind: t('designer.kind.' + st.kind) })
        : !named ? t('designer.needName')
        : !said ? t('designer.needBody')
        : t('designer.builderNote');
    }
    function paintAll() {
      for (const b of modes.children) b.classList.toggle('on', b.dataset.mode === st.mode);
      for (const b of kinds.children) b.classList.toggle('on', b.dataset.kind === st.kind);
      const upd = st.mode === 'update';
      about.style.display = upd ? 'none' : '';
      home.style.display = upd ? 'none' : '';
      about.textContent = t('designer.about.' + st.kind);
      home.textContent = t('designer.livesAt', { path: t('designer.home.' + st.kind) });
      pickMine.style.display = upd ? '' : 'none';
      pickMine.textContent = st.targetPath
        ? t('designer.updatingNote', { path: st.targetPath })
        : t('designer.pickMine', { kind: t('designer.kind.' + st.kind) });
      paintFields();
      paintGo();
    }
    paintAll();
  });
}

/* Launch (or reveal) the primary session — no trailing prompt. */
function launchPrimary(primary) {
  const hit = byName(primary);
  if (hit && !panes.get(hit[0]).exited) { setActive(hit[0]); return; }
  void createPane({ name: primary, cmd: CLAUDE + ' --name ' + primary + ' ' + shq(RITUAL_BOOTSTRAP) });
}

/* Rituals + nudges run in the PRIMARY session (Glass parity) — reuse it when it
   exists, create it named when it doesn't. */
async function runInPrimary(slash) {
  const cfg = await window.glassShell.shellConfig();
  const primary = cfg.primary || 'aios';
  const hit = byName(primary);
  if (hit && !panes.get(hit[0]).exited) {
    submitToPty(hit[0], slash);
    setActive(hit[0]);
  } else {
    void createPane({ name: primary, cmd: CLAUDE + ' --name ' + primary + ' ' + shq(slash) });
  }
}

// #6 "run where?" — when terminalMode is 'ask' AND there are live sessions to
// choose among, offer a picker (each live session + New terminal); otherwise fall
// to runInPrimary (primary if live, else a new named pane). Only asks when there's
// a real choice, so a wrong guess is never forced (Glass terminalMode parity).
async function runWhere(slash, name) {
  const cfg = await window.glassShell.shellConfig();
  const live = (pulse.lastRunning && pulse.lastRunning.running) || [];
  if ((cfg.terminalMode || 'ask') !== 'ask' || !live.length) return runInPrimary(slash);
  // same searchable/selectable picker as every other popup (#28)
  const choices = [
    { label: t('run.newTerminal'), desc: t('run.newTerminalHint'), icon: 'term', value: '__new' },
    ...live.map((a) => ({ label: a.name, desc: statusInfo(a.status).label, icon: 'robot', value: a.name })),
  ];
  const choice = await listModal(t('run.where'), choices, t('run.wherePlaceholder'));
  if (!choice) return;
  if (choice === '__new') { void createPane({ name: name || 'run', cmd: CLAUDE + ' --name ' + (name || 'run') + ' ' + shq(slash) }); return; }
  const hit = byName(choice);
  if (hit && !panes.get(hit[0]).exited) { submitToPty(hit[0], slash); setActive(hit[0]); }
  else void createPane({ name: name || choice, cmd: CLAUDE + ' --name ' + (name || choice) + ' ' + shq(slash) });
}

function runFrequent(t) {
  const a = (t.assignment || '').trim();
  if (t.kind === 'agent') void runWhere('/aios:agent ' + t.target + (a ? ' — ' + a : ''), t.target);
  else if (t.kind === 'command') void runWhere('/aios:' + t.target + (a ? ' ' + a : ''), t.target);
  else if (t.kind === 'skill') void runWhere('Use the ' + t.target + ' skill' + (a ? ': ' + a : '.'), t.target);
  else void runWhere(t.target, 'task');
}

/* ── quick open (⌘P): any file across vault + workspace ────────────────────── */
async function quickOpen() {
  const idx = await window.glassShell.fsIndex();
  const v = await listModal(t('quickOpen.title'), idx.map((f) => ({ label: f.name, desc: f.root + ' · ' + f.path.split('/').slice(-3, -1).join('/'), icon: fileIconName(f.name), value: f.path })), t('quickOpen.placeholder'));
  if (v) void openViewer(v);
}

/* ── context / daily / suggestion / ingest / reports flows ─────────────────── */
async function pickContext(kind) {
  const roots = await window.glassShell.fsRoots();
  if (!roots.vault) return;
  if (!kind) {
    kind = await listModal(t('context.browse'), [
      { label: t('context.declared'), desc: t('context.declaredDesc'), icon: 'md', value: 'declared' },
      { label: t('context.observed'), desc: t('context.observedDesc'), icon: 'md', value: 'observed' },
      { label: t('context.projects'), desc: t('context.projectsDesc'), icon: 'md', value: 'projects' },
    ], '');
    if (!kind) return;
  }
  const dir = kind === 'projects' ? roots.vault + '/00 - notes/projects' : roots.vault + '/00 - notes/context/' + kind;
  const files = await sortedList(dir); // fs:list is unsorted now (AI-58) — sort like the explorer would
  const title = { declared: t('context.declared'), observed: t('context.observed'), projects: t('context.projects') }[kind] || (kind[0].toUpperCase() + kind.slice(1));
  const f = await listModal(title, files.filter((x) => !x.dir && x.name.endsWith('.md') && x.name !== '_index.md').map((x) => ({ label: x.name.replace(/\.md$/, ''), icon: 'md', value: x.path })), t('context.openNote'));
  if (f) void openViewer(f);
}
async function pickDaily() {
  const v = await listModal(t('daily.title'), [
    { label: t('daily.planDay'), desc: '/today', icon: 'layout', value: 'today' },
    { label: t('daily.closeSession'), desc: '/close-session', icon: 'layout', value: 'close-session' },
    { label: t('daily.closeDay'), desc: '/close-day', icon: 'layout', value: 'close-day' },
  ], '');
  if (v) void runWhere('/aios:' + v, v);
}
async function pickSuggestion() {
  const { suggestions } = await window.glassShell.aiosLists();
  if (!suggestions.length) { toast(t('suggestion.none')); return; }
  const v = await listModal(t('suggestion.title'), suggestions.map((x) => ({ label: x.task, desc: x.agent ? t('suggestion.agentDesc', { agent: x.agent }) : t('suggestion.commandDesc', { command: x.command || '' }), icon: 'md', value: x })), t('suggestion.placeholder'));
  if (!v) return;
  if (v.agent) void runWhere('/aios:agent ' + v.agent + ' — ' + v.task, v.agent);
  else if (v.command) void runWhere(v.command + (v.url ? ' ' + v.url : ''), v.command.replace(/^\/(aios:)?/, '').split(/\s/)[0]);
}
async function ingestFlow() {
  const src = await inputModal(t('ingest.title'), t('ingest.placeholder'));
  if (src !== null) void runWhere('/aios:ingest' + (src ? ' ' + src : ''), 'ingest');
}
async function reportsFlow() {
  const type = await listModal(t('reports.title'), [
    { label: t('reports.role'), desc: '/aios:role-report', icon: 'md', value: 'role' },
    { label: t('reports.weekly'), desc: '/aios:weekly-learnings', icon: 'md', value: 'weekly' },
    { label: t('reports.status'), desc: t('reports.statusDesc'), icon: 'md', value: 'status' },
  ], '');
  if (!type) return;
  const period = await inputModal(t('reports.periodTitle'), t('reports.periodPlaceholder'));
  if (period === null) return;
  if (type === 'role') void runWhere('/aios:role-report ' + (period || 'this week'), 'role-report');
  else if (type === 'weekly') void runWhere('/aios:weekly-learnings ' + (period || 'this week'), 'weekly-learnings');
  else void runWhere('/aios:agent report-drafter — Status report (period: ' + (period || 'this week') + ')', 'report-drafter');
}

/* ── ⌘⌥G chords: the extension's exact letters (muscle-memory parity) ──────── */
let chordAt = 0;
function chordActive() { return Date.now() - chordAt < 1800; }
function handleChord(e) {
  if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === 'KeyG') {
    chordAt = Date.now();
    toast(t('chord.hint'));
    return true;
  }
  if (!chordActive()) return false;
  chordAt = 0;
  const code = e.code;
  const send = (command, ...args) => window.glassShell.panelSend({ type: 'cmd', command, args });
  const iso = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  switch (code) {
    case 'KeyQ': send('aios.askAios'); return true;
    case 'KeyD': void pickDaily(); return true;
    case 'KeyF': void pickFrequent(); return true;
    case 'KeyA': void pickAgent(); return true;
    case 'KeyK': void pickSkill(); return true;
    case 'KeyC': void pickCommand(); return true;
    case 'KeyI': void ingestFlow(); return true;
    case 'KeyR': void pickRunning(); return true;
    case 'KeyS': void spawnWorkerFlow(); return true;
    case 'KeyT': void createPane({ name: 'terminal' }); return true;
    case 'KeyE': void reportsFlow(); return true;
    case 'KeyX': void pickContext(''); return true;
    case 'KeyP': send('aios.personalizationsPicker'); return true;
    case 'KeyW': void pickContext('projects'); return true;
    case 'KeyM': send('aios.minimizeCards'); return true;
    case 'KeyH': openHomeTab(); return true; // Home is a TAB, not a layout (it used to cycle presets)
    case 'KeyY': window.glassShell.panelSend({ type: 'openDay', date: iso() }); return true;
    case 'KeyG': send('aios.goWithAgents'); return true;
    case 'KeyB': document.getElementById('railExplorer').click(); return true; // files (Glass parity)
    case 'Comma': openSettingsTab(); return true;
    case 'Digit8': void openPalette(); return true; // * (shift+8)
    default: return false;
  }
}
window.addEventListener('keydown', (e) => { if (handleChord(e)) { e.preventDefault(); e.stopPropagation(); } }, true);

/* ⌘1–4 (layouts) and ⌘0 (terminals below) are NOT handled here: they are native menu
   accelerators in src/main/menu.ts, which the OS resolves before the renderer sees the
   keystroke. A handler here would be shadowed on macOS and drift from the menu. */

/* ── ask modal + toasts ───────────────────────────────────────────────────── */
function recentAsks() {
  try { return JSON.parse(localStorage.getItem('recentAsks') || '[]'); } catch { return []; }
}
function pushRecentAsk(t) {
  try {
    const r = [t, ...recentAsks().filter((x) => x !== t)].slice(0, 4);
    localStorage.setItem('recentAsks', JSON.stringify(r));
  } catch { /* ignore */ }
}
async function askWithChips() {
  const v = await inputModal(t('ask.title'), t('ask.placeholder'), recentAsks());
  if (v) pushRecentAsk(v);
  return v;
}

// A minimal choice modal (reuses the input-modal chrome + chip styling): a title
// and a row of buttons; resolves the chosen key, or null on Escape/backdrop.
// #12 session post-its: a small modal to view / add / delete reminders on a live
// session. Notes persist in .glass/state.json (main side), keyed by session name.
async function openSessionNotes(name) {
  let notes = await window.glassShell.notesGet(name).catch(() => []);
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal"><div class="mtitle"></div><div class="noteslist"></div><input class="notesinput tinput" /><div class="mhint"></div></div>`;
  wrap.querySelector('.mtitle').textContent = t('session.notesTitle', { name });
  wrap.querySelector('.mhint').textContent = t('session.notesHint');
  const input = wrap.querySelector('.notesinput');
  input.placeholder = t('session.notesPlaceholder');
  const list = wrap.querySelector('.noteslist');
  const paint = () => {
    list.replaceChildren();
    if (!notes.length) { list.appendChild(el('div', 'psubempty', t('session.notesEmpty'))); return; }
    notes.forEach((n, i) => {
      const row = el('div', 'noterow');
      row.appendChild(el('span', 'notetext', n.t));
      const del = el('button', 'notedel'); del.innerHTML = icon('stop', 10); del.title = t('session.notesDelete');
      del.addEventListener('click', async () => { notes = await window.glassShell.notesDel(name, i).catch(() => notes); paint(); void refreshNoteCounts(); });
      row.appendChild(del);
      list.appendChild(row);
    });
  };
  paint();
  document.body.appendChild(wrap);
  input.focus();
  const done = () => wrap.remove();
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') { e.preventDefault(); const v = input.value.trim(); if (v) { notes = await window.glassShell.notesAdd(name, v).catch(() => notes); input.value = ''; paint(); void refreshNoteCounts(); } }
    else if (e.key === 'Escape') { e.preventDefault(); done(); }
  });
  wrap.addEventListener('click', (e) => { if (e.target === wrap) done(); });
}

function inputModal(title, placeholder, chips, opts) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `<div class="modal"><div class="mtitle"></div>
      <input id="askInput" />
      <div class="mhint"></div></div>`;
    wrap.querySelector('.mhint').textContent = t('modal.runHint');
    wrap.querySelector('.mtitle').textContent = title;
    wrap.querySelector('#askInput').placeholder = placeholder;
    document.body.appendChild(wrap);
    const input = wrap.querySelector('#askInput');
    if (opts && opts.password) input.type = 'password'; // secrets (PAT) never render on screen
    if (chips && chips.length) {
      const cw = document.createElement('div');
      cw.className = 'chips';
      for (const c of chips) {
        const b = document.createElement('button');
        b.className = 'chip';
        b.textContent = c;
        b.addEventListener('click', () => { input.value = c; input.focus(); });
        cw.appendChild(b);
      }
      input.after(cw);
    }
    input.focus();
    const done = (val) => { wrap.remove(); resolve(val); };
    // Enter resolves the (trimmed) string — '' is a valid "submit blank" (e.g. spawn → adj-animal
    // handle); only Escape / backdrop resolve null (cancel). Callers distinguish '' from null.
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); done(input.value.trim()); }
      else if (e.key === 'Escape') { e.preventDefault(); done(null); }
    });
    wrap.addEventListener('click', (e) => { if (e.target === wrap) done(null); });
  });
}

const TOAST_MAX = 4, TOAST_MS = 3200;
/* Toasts stack in a column instead of piling onto one pixel. Three refinements the naive
   version needed once more than one could be seen at a time:
     • an identical message REFRESHES the one already showing rather than adding a twin — a
       polled check that keeps failing would otherwise paper the screen with the same sentence;
     • the oldest is retired past TOAST_MAX, so a burst cannot cover the window;
     • the container is created lazily and ignores pointer events, so it can never swallow a
       click meant for what is underneath it. */
function toast(text) {
  let host = document.getElementById('toasts');
  if (!host) { host = document.createElement('div'); host.id = 'toasts'; document.body.appendChild(host); }
  const existing = [...host.children].find((c) => c.textContent === text);
  if (existing) {
    clearTimeout(Number(existing.dataset.timer));
    existing.dataset.timer = String(setTimeout(() => retire(existing), TOAST_MS));
    return;
  }
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  host.appendChild(t);
  /* Remove the overflow SYNCHRONOUSLY. `retire` fades over 300ms before removing, so a
     `while (children.length > MAX) retire(...)` loop never terminates — the count cannot drop
     inside the loop. That froze the renderer outright, caught only because a probe hung; a
     deferred effect can never satisfy a synchronous condition. */
  while (host.children.length > TOAST_MAX) {
    const oldest = host.firstElementChild;
    clearTimeout(Number(oldest.dataset.timer));
    oldest.remove();
  }
  setTimeout(() => t.classList.add('show'), 10);
  t.dataset.timer = String(setTimeout(() => retire(t), TOAST_MS));
}
function retire(t) {
  if (!t) return;
  clearTimeout(Number(t.dataset.timer));
  t.classList.remove('show');
  setTimeout(() => t.remove(), 300);
}

/* Re-localize everything when the operator switches language live. The native
   menu + main-process pulse strings are rebuilt by main.ts (it re-emits state on
   the locale setting change); here we refresh the renderer-owned surfaces. */
function relocalize(loc) {
  if (window.i18n) window.i18n.setLocale(loc);
  applyStaticI18n();
  paintRailTitles();
  paintThemeBtn();
  ctxEl = null; // rebuild the cached right-click menu with new labels on next open
  void paintExplorer();
  if (pulse.lastState) renderActionCards(pulse.lastState);
  if (pulse.lastRunning) renderPulseRunning(pulse.lastRunning);
  if (pulse.lastMonth) paintCalendar();
  void refreshHealth(); // re-render the Health card with the new locale's labels
  // re-open any synthetic tool tabs (Settings/Setup/Plugins/Home) so their labels refresh
  for (const [id, pane] of [...panes]) {
    if (pane.kind !== 'view' || !String(pane.path).startsWith('::')) continue;
    const wasActive = active.main === id;
    closePane(id);
    if (pane.path === '::settings') openSettingsTab();
    else if (pane.path === '::setup') openSetupTab();
    else if (pane.path === '::plugins') openPluginsTab();
    else if (pane.path === '::designer') openDesignerTab();
    else if (pane.path === '::home') openHomeTab();
    if (!wasActive) { /* leave focus where it was */ }
  }
}

/* ── boot ─────────────────────────────────────────────────────────────────── */
applyLayout();
applyPulseOrder();
void initLocale().then(async () => {
  applyStaticI18n();       // re-resolve static HTML now that the real locale is loaded
  openHomeTab();
  pulse.send({ type: 'ready' });
  void refreshHealth();    // the Health card runs its first doctor pass at boot…
  setInterval(() => void refreshHealth(), 5 * 60 * 1000); // …then re-checks quietly
  /* FIRST RUN: with no framework or no vault the app cannot do anything useful, and every
     route to Setup was a control a newcomer has no reason to click — so they landed on an
     empty workspace and a greeting with no next step. Open Setup for them.
     Deliberately not a once-only flag: while the framework is missing this IS the only
     useful screen, and once it exists the branch never runs again. */
  try {
    const roots = await window.glassShell.fsRoots();
    if (!roots.framework || !roots.vault) openSetupTab();
  } catch { /* if we cannot even ask, the Setup tab is still reachable by hand */ }
});

window.__workbenchOk = true; // smoke gate 4
