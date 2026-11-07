/* ASK AIOS — where an Ask goes: a new session, a live session, or an agent (0.15.0, operator round 2).
   ONE picker for both doors: the Ask panel in the App and the floating Ask AIOS bar opened from any app by the
   optional global shortcut. Both pages load this classic script and get `window.AskDest`; the look lives in
   theme.css (`.adest-*`), so the two cannot drift apart.

   A chip under the text ("→ New session ▾") opens a list with a filter: New session first, then Live sessions,
   then Agents. Tab in the text field opens it; ↑/↓ move, Enter picks, Esc or Tab closes. */
'use strict';
(function () {
  /** The rows the list shows for a filter: pure, so a test can run it. Headers carry `group`, pickable rows `kind`. */
  function buildRows(q, data, S) {
    const f = String(q || '').trim().toLowerCase();
    const hit = (s) => !f || String(s || '').toLowerCase().includes(f);
    const out = [{ kind: 'new', name: '', label: S.newSession }];
    const ss = ((data && data.sessions) || []).filter((s) => s && s.name && hit(s.name));
    if (ss.length) { out.push({ group: S.sessions }); for (const s of ss) out.push({ kind: 'session', name: s.name, label: s.name, waiting: !!s.waiting }); }
    const as = ((data && data.agents) || []).filter((a) => a && a.name && (hit(a.name) || hit(a.desc)));
    if (as.length) { out.push({ group: S.agents }); for (const a of as) out.push({ kind: 'agent', name: a.name, label: a.name, desc: a.desc || '' }); }
    return out;
  }

  /** The chip's text for a destination. */
  function chipLabel(dest, S) {
    if (!dest || dest.kind === 'new') return S.newSession;
    return dest.name;
  }

  /**
   * Mount the picker. `chipHost` receives the chip, `listHost` the list (placed where each page wants it).
   * opts: { strings, load() → Promise<{sessions, agents}>, onChange(dest), returnFocus: element }.
   * Returns { get dest, open(), close(), isOpen() }.
   */
  function mount(chipHost, listHost, opts) {
    const S = opts.strings;
    let data = { sessions: [], agents: [] };
    let dest = { kind: 'new', name: '' };
    let rows = [], sel = 0;

    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'adest-chip';
    chip.setAttribute('aria-haspopup', 'listbox');
    const arrow = document.createElement('span'); arrow.className = 'adest-arrow'; arrow.textContent = '→';
    const lbl = document.createElement('span'); lbl.className = 'adest-lbl';
    const kind = document.createElement('span'); kind.className = 'adest-kind';
    const car = document.createElement('span'); car.className = 'adest-car'; car.textContent = '▾';
    chip.append(arrow, lbl, kind, car);
    chipHost.appendChild(chip);

    const list = document.createElement('div');
    list.className = 'adest-list';
    list.hidden = true;
    const filter = document.createElement('input');
    filter.className = 'adest-filter';
    filter.spellcheck = false; filter.autocomplete = 'off';
    filter.placeholder = S.filter;
    const items = document.createElement('ul');
    items.className = 'adest-items';
    items.setAttribute('role', 'listbox');
    list.append(filter, items);
    listHost.appendChild(list);

    function paint() {
      lbl.textContent = chipLabel(dest, S);
      kind.textContent = dest.kind === 'agent' ? S.agentTag : dest.kind === 'session' ? S.sessionTag : '';
      kind.hidden = dest.kind === 'new';
      chip.title = S.hint || '';
    }
    function render() {
      rows = buildRows(filter.value, data, S);
      const pick = rows.filter((r) => r.kind);
      if (sel >= pick.length) sel = Math.max(0, pick.length - 1);
      items.textContent = '';
      let i = 0;
      for (const r of rows) {
        const li = document.createElement('li');
        if (!r.kind) { li.className = 'adest-grp'; li.textContent = r.group; items.appendChild(li); continue; }
        const idx = i++;
        li.className = 'adest-it' + (idx === sel ? ' sel' : '');
        li.setAttribute('role', 'option');
        const n = document.createElement('span'); n.className = 'adest-n'; n.textContent = r.label; li.appendChild(n);
        if (r.waiting) { const w = document.createElement('span'); w.className = 'adest-w'; w.textContent = S.waiting; li.appendChild(w); }
        if (r.desc) { const d = document.createElement('span'); d.className = 'adest-d'; d.textContent = r.desc; li.appendChild(d); }
        /* Chosen on CLICK, not mousedown (round 3): hiding the list on mousedown shrank the dialog under the pointer, so the
           mouseup/click that followed landed on the backdrop and cancelled the whole Ask. mousedown only keeps the focus. */
        li.addEventListener('mousedown', (e) => { e.preventDefault(); });
        li.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); choose(r); });
        items.appendChild(li);
        if (idx === sel) li.scrollIntoView({ block: 'nearest' });
      }
    }
    function open() {
      list.hidden = false; chip.classList.add('open'); filter.value = ''; sel = 0; render(); filter.focus();
      void Promise.resolve(opts.load()).then((d) => { data = d || data; if (!list.hidden) render(); }).catch(() => {});
    }
    function close(focus) { list.hidden = true; chip.classList.remove('open'); if (focus !== false && opts.returnFocus) opts.returnFocus.focus(); }
    function choose(r) {
      dest = r.kind === 'new' ? { kind: 'new', name: '' } : { kind: r.kind, name: r.name };
      paint(); close();
      if (opts.onChange) opts.onChange(dest);
    }

    chip.addEventListener('mousedown', (e) => { e.preventDefault(); if (list.hidden) open(); else close(); });
    chip.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); open(); } });
    filter.addEventListener('input', () => { sel = 0; render(); });
    filter.addEventListener('keydown', (e) => {
      const n = rows.filter((r) => r.kind).length || 1;
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % n; render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + n) % n; render(); }
      else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); const r = rows.filter((x) => x.kind)[sel]; if (r) choose(r); }
      else if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); close(); }
    });
    void Promise.resolve(opts.load()).then((d) => { data = d || data; }).catch(() => {});
    paint();
    return {
      get dest() { return dest; },
      open, close, isOpen: () => !list.hidden,
    };
  }

  window.AskDest = { buildRows, chipLabel, mount };
})();
