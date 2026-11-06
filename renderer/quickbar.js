/* The quick bar (docs/rfcs/menu-bar.md § 2.2). One line of text and one destination; Enter sends.
   Everything it knows comes from `window.quickBar` (src/preload/quickBarPreload.ts), strings included,
   so this page needs no i18n bundle of its own. */
'use strict';
(() => {
  const api = window.quickBar;
  const $ = (id) => document.getElementById(id);
  const text = $('text'), dest = $('dest'), nameIn = $('name'), err = $('err'), hint = $('hint');
  const list = $('list'), filter = $('filter'), items = $('items');

  let S = {};                 // strings from main
  let agents = [], sessions = [], waitingLabel = '';
  let target = { kind: 'new', name: '' };
  let nameEdited = false;     // once the operator types a name, suggestions stop overwriting it
  let rows = [], sel = 0;
  let suggestTimer = 0, sending = false;

  function paintDest() {
    const lbl = dest.querySelector('.lbl');
    lbl.textContent = target.kind === 'new' ? S.newSession : (target.kind === 'agent' ? '🤖 ' : '→ ') + target.name;
    nameIn.hidden = target.kind !== 'new';
    if (target.kind === 'new') nameIn.value = target.name;
  }
  function showErr(msg) { err.textContent = msg || ''; err.hidden = !msg; }

  async function open(msg) {
    document.body.classList.toggle('light', msg && msg.theme === 'light');
    const d = await api.destinations();
    S = d.strings; agents = d.agents || []; sessions = d.sessions || []; waitingLabel = d.waitingLabel || '';
    text.placeholder = S.placeholder; filter.placeholder = S.filter; hint.textContent = S.hint; nameIn.title = S.nameLabel;
    text.value = ''; showErr(''); closeList();
    target = { kind: 'new', name: await api.suggestName('') }; nameEdited = false;
    paintDest();
    text.focus();
  }

  /* ── destination list ─────────────────────────────────────────────────────────────── */
  function buildRows(q) {
    const f = q.trim().toLowerCase();
    const hit = (s) => !f || s.toLowerCase().includes(f);
    const out = [];
    out.push({ group: null, kind: 'new', name: '', label: S.newSession });
    const ss = sessions.filter((s) => hit(s.name));
    if (ss.length) { out.push({ group: S.sessions }); for (const s of ss) out.push({ kind: 'session', name: s.name, label: s.name, w: s.waiting }); }
    const as = agents.filter((a) => hit(a.name) || hit(a.desc || ''));
    if (as.length) { out.push({ group: S.agents }); for (const a of as) out.push({ kind: 'agent', name: a.name, label: a.name, desc: a.desc }); }
    return out;
  }
  function renderList() {
    rows = buildRows(filter.value);
    const pickable = rows.filter((r) => r.kind);
    if (sel >= pickable.length) sel = Math.max(0, pickable.length - 1);
    items.textContent = '';
    let i = 0;
    for (const r of rows) {
      const li = document.createElement('li');
      if (!r.kind) { li.className = 'grp'; li.textContent = r.group; items.appendChild(li); continue; }
      const idx = i++;
      li.className = 'it' + (idx === sel ? ' sel' : '');
      const n = document.createElement('span'); n.textContent = r.label; li.appendChild(n);
      if (r.w) { const w = document.createElement('span'); w.className = 'w'; w.textContent = '● ' + waitingLabel; li.appendChild(w); }
      if (r.desc) { const d = document.createElement('span'); d.className = 'd'; d.textContent = r.desc; li.appendChild(d); }
      li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(r); });
      items.appendChild(li);
      if (idx === sel) li.scrollIntoView({ block: 'nearest' });
    }
  }
  function openList() { list.hidden = false; dest.classList.add('open'); filter.value = ''; sel = 0; renderList(); filter.focus(); }
  function closeList() { list.hidden = true; dest.classList.remove('open'); }
  async function choose(r) {
    if (r.kind === 'new') { target = { kind: 'new', name: await api.suggestName(text.value) }; nameEdited = false; }
    else target = { kind: r.kind, name: r.name };
    paintDest(); closeList(); text.focus();
  }

  /* ── sending ──────────────────────────────────────────────────────────────────────── */
  async function send(reveal) {
    if (sending) return;
    if (target.kind === 'new') target.name = nameIn.value.trim() || target.name;
    if (target.kind === 'session' && !text.value.trim()) { showErr(S.emptyText); return; }
    sending = true;
    try {
      const r = await api.submit(target, text.value, reveal);
      if (!r || !r.ok) showErr(S.failed + (r && r.reason ? ' (' + r.reason + ')' : ''));
    } finally { sending = false; }
  }

  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); void send(e.metaKey || e.ctrlKey); }
    else if (e.key === 'Escape') { e.preventDefault(); api.close(); }
    else if (e.key === 'Tab') { e.preventDefault(); openList(); }
  });
  text.addEventListener('input', () => {
    showErr('');
    if (target.kind !== 'new' || nameEdited) return;
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(async () => { if (target.kind === 'new' && !nameEdited) { target.name = await api.suggestName(text.value); nameIn.value = target.name; } }, 250);
  });
  nameIn.addEventListener('input', () => { nameEdited = true; });
  nameIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); void send(e.metaKey || e.ctrlKey); }
    else if (e.key === 'Escape') { e.preventDefault(); api.close(); }
  });
  dest.addEventListener('mousedown', (e) => { e.preventDefault(); if (list.hidden) openList(); else { closeList(); text.focus(); } });
  filter.addEventListener('input', () => { sel = 0; renderList(); });
  filter.addEventListener('keydown', (e) => {
    const n = rows.filter((r) => r.kind).length;
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % n; renderList(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + n) % n; renderList(); }
    else if (e.key === 'Enter') { e.preventDefault(); const r = rows.filter((x) => x.kind)[sel]; if (r) void choose(r); }
    else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); closeList(); text.focus(); }
  });

  api.onOpen((msg) => { void open(msg); });
})();
