/* ASK AIOS FROM ANY APP (docs/rfcs/menu-bar.md § 2.2). The same Ask as the panel in the App, opened by the optional
   global shortcut: one line of text and one destination; Enter sends. The destination picker is AskDest
   (renderer/askdest.js), the one the Ask panel uses, so both doors look and behave alike (0.15.0 round 2).
   Everything it knows comes from `window.quickBar` (src/preload/quickBarPreload.ts), strings included,
   so this page needs no i18n bundle of its own. */
'use strict';
(() => {
  const api = window.quickBar;
  const $ = (id) => document.getElementById(id);
  const text = $('text'), nameIn = $('name'), err = $('err'), hint = $('hint'), ttl = $('ttl');

  let S = {};                 // strings from main
  let cache = { sessions: [], agents: [] };
  let picker = null;
  let newName = '';
  let nameEdited = false;     // once the operator types a name, suggestions stop overwriting it
  let suggestTimer = 0, sending = false;

  function showErr(msg) { err.textContent = msg || ''; err.hidden = !msg; }
  const dest = () => (picker ? picker.dest : { kind: 'new', name: '' });

  function mountPicker() {
    $('dest').textContent = ''; $('list').textContent = '';
    picker = window.AskDest.mount($('dest'), $('list'), {
      strings: S,
      load: () => Promise.resolve(cache),
      returnFocus: text,
      onChange: async (d) => {
        nameIn.hidden = d.kind !== 'new';
        if (d.kind === 'new') { newName = await api.suggestName(text.value); nameEdited = false; nameIn.value = newName; }
      },
    });
  }

  async function open(msg) {
    document.body.classList.toggle('light', msg && msg.theme === 'light');
    const d = await api.destinations();
    S = d.strings; cache = { sessions: d.sessions || [], agents: d.agents || [] };
    ttl.textContent = S.title || '';
    text.placeholder = S.placeholder; hint.textContent = S.hint; nameIn.title = S.nameLabel;
    text.value = ''; showErr('');
    mountPicker();
    newName = await api.suggestName(''); nameEdited = false;
    nameIn.hidden = false; nameIn.value = newName;
    text.focus();
  }

  async function send(reveal) {
    if (sending) return;
    const d = dest();
    const target = d.kind === 'new' ? { kind: 'new', name: nameIn.value.trim() || newName } : { kind: d.kind, name: d.name };
    if (target.kind === 'session' && !text.value.trim()) { showErr(S.emptyText); return; }
    sending = true;
    try {
      const r = await api.submit(target, text.value, reveal);
      if (!r || !r.ok) showErr(S.failed + (r && r.reason ? ' (' + r.reason + ')' : ''));
    } finally { sending = false; }
  }

  text.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); void send(e.metaKey || e.ctrlKey); }
    else if (e.key === 'Escape') { e.preventDefault(); if (picker && picker.isOpen()) picker.close(); else api.close(); }
    else if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); if (picker) picker.open(); }
  });
  text.addEventListener('input', () => {
    showErr('');
    if (dest().kind !== 'new' || nameEdited) return;
    clearTimeout(suggestTimer);
    suggestTimer = setTimeout(async () => { if (dest().kind === 'new' && !nameEdited) { newName = await api.suggestName(text.value); nameIn.value = newName; } }, 250);
  });
  nameIn.addEventListener('input', () => { nameEdited = true; });
  nameIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); void send(e.metaKey || e.ctrlKey); }
    else if (e.key === 'Escape') { e.preventDefault(); api.close(); }
  });

  api.onOpen((msg) => { void open(msg); });
})();
