/**
 * The chat skin — a second way of LOOKING at a Claude terminal pane, never a pane of its own.
 *
 * Source-reading invariants, in the style of menu.test.ts. They exist because every failure this
 * feature can have is silent at the unit level: a toggle that spawned a second pty would still
 * "work"; a hidden xterm that went `display:none` would resize the real session to 0 columns and
 * break the TUI only when the operator came back; a composer that wrote `text + CR` in one chunk
 * would deliver a message that never sends. None of that throws, so each guard reads the code and
 * every guard is paired with a NEGATIVE CONTROL — the same check run against a deliberately broken
 * copy of the source must fail, or the check proves nothing (it would be a gate that reads the
 * wrong thing and reports confidence about something it never examined).
 *
 * What these cannot see: that the bubbles actually paint and the strip actually shows. That is the
 * hidden-window run (see the PR description), not a source test.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as ts from 'typescript';
import { detectTuiPrompt, createPromptMonitor } from '../core/tuiPrompt';
import { normalizeClaudeView } from '../main/aios';

const read = (p: string): string => fs.readFileSync(p, 'utf8');
const app = read('renderer/app.js');
const menu = read('src/main/menu.ts');
const css = read('renderer/theme.css');
const html = read('renderer/index.html');
const main = read('src/main/main.ts');
const preload = read('src/preload/preload.ts');

const START = '/* ═══ CHAT SKIN';
const END = '/* ═══ END CHAT SKIN ═══ */';
const slice = (src: string): string => {
  const a = src.indexOf(START);
  const b = src.indexOf(END);
  return a >= 0 && b > a ? src.slice(a, b) : '';
};
const skin = slice(app);

/** A top-level function (or arrow const) by name: from its header to the first closing brace at column 0. */
function fnBody(src: string, name: string): string {
  const re = new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}|const ${name} = [^\\n]*=> \\{[\\s\\S]*?\\n\\};`);
  return re.exec(src)?.[0] ?? '';
}
/** Run a check against the real source (must hold) and against a broken copy (must fail). */
function guarded(name: string, check: (src: string) => boolean, breakIt: (src: string) => string): void {
  test(name, () => {
    assert.ok(check(app), `${name}: the check does not hold on the real source`);
    const broken = breakIt(app);
    assert.notEqual(broken, app, `${name}: the negative control did not change anything`);
    assert.equal(check(broken), false, `${name}: the check still passes on a deliberately broken copy — it proves nothing`);
  });
}

test('the chat-skin block was found, once, and the SDK pane is gone', () => {
  assert.ok(skin.length > 5000, 'the block between the CHAT SKIN markers must exist');
  assert.equal(app.split(START).length, 2, 'exactly one start marker');
  assert.equal(app.split(END).length, 2, 'exactly one end marker');
});

// ── the SDK pane is gone ────────────────────────────────────────────────────

const SDK_TRACES = /kind: 'chat'|kind === 'chat'|openChatPane|chatPanes|\bchatStart\b|\bchatSend\b|\bchatInterrupt\b|\bchatPermission\b|\bchatClose\b|\bonChatEvent\b/;
guarded('no pane kind "chat" and no SDK chat call survives in the renderer or the menu',
  (src) => !SDK_TRACES.test(src) && !/openChat/.test(menu) && !/newChat/.test(html + css),
  (src) => src + "\nwindow.glassShell.chatStart({ startSession: true });\n");

// ── the toggle only flips a view ────────────────────────────────────────────

const CREATES = /createPane\(|ptySpawn\(|panes\.set\(|new Terminal\(|homePane\(|makeTab\(/;
guarded('changing the mode creates no pane, no pty and no session: it flips a view on the same pane objects',
  (src) => {
    const s = slice(src);
    const fns = ['chatSkinSetView', 'chatSkinApplyMode', 'chatSkinSetMode', 'chatSkinToggleMode', 'chatSkinFollowMode', 'chatSkinBuild', 'chatSkinLayout', 'chatSkinHandBack'].map((n) => fnBody(s, n));
    return fns.every((b) => b.length > 40 && !CREATES.test(b)) && !CREATES.test(s.replace(fnBody(s, 'chatSkinMaybeDefault'), ''));
  },
  (src) => src.replace('function chatSkinSetView(id, view) {', 'function chatSkinSetView(id, view) {\n  void createPane({ name: "chat" });'));

test('the skin only adds fields and DOM inside p.el: it never reassigns the pane identity', () => {
  // identity = what byName / resume / the bus / restore key on. The skin may ADD p.view, p.chatSkin,
  // p.lastPtyAt (set outside), p.csEligible, p.chatEnded; it must not rename or re-key anything.
  for (const bad of [/\.name\s*=[^=]/, /\.confirmedName\s*=[^=]/, /\.cmd\s*=[^=]/, /panes\.delete\(/, /panes\.set\(/, /\.isSession\s*=[^=]/, /renamePane\(/]) {
    assert.doesNotMatch(skin, bad, `the skin must not touch ${bad}`);
  }
  // the single exception, stated: a session replaced under the same pty is re-resolved from the registry's own authority
  const assigns = [...skin.matchAll(/\.sessionId\s*=[^=]/g)].length;
  assert.equal(assigns, 1, 'exactly one sessionId assignment in the skin');
  assert.match(fnBody(skin, 'chatSkinRecheckId'), /sessionUnder\(\[id\]\)[\s\S]*p\.sessionId = real\.id/);
  // every overlay node lives inside the pane's own element
  assert.match(fnBody(skin, 'chatSkinBuild'), /p\.el\.appendChild\(root\)/);
});

// ── the composer writes through the one chokepoint ──────────────────────────

guarded('the composer submits through submitToPty, never by writing a CR itself',
  (src) => {
    const s = slice(src);
    // the typed message and the bar's model button both end in chatSkinSubmit, the one place that hands text to submitToPty
    const send = fnBody(s, 'chatSkinSubmit') + fnBody(s, 'chatSkinSendNow');
    // every direct pty write in the skin is the lone ESC, or one chunk of a dialog key inside the key chokepoint; nothing writes text or a CR
    const writes = [...s.replace(fnBody(s, 'chatSkinSendKey'), '').matchAll(/ptyWrite\(([^)]*)\)/g)].map((m) => m[1].replace(/\s+/g, ' ').trim());
    return /submitToPty\(id, text\)/.test(send) && /chatSkinSubmit\(id, p, text\)/.test(fnBody(s, 'chatSkinSendNow')) && writes.length >= 1 && writes.every((w) => w === "id, '\\x1b'");
  },
  (src) => src.replace('submitToPty(id, text);   // the one chokepoint', "window.glassShell.ptyWrite(id, text + '\\r');   // the one chokepoint"));

guarded('slash commands are sent exactly like any other message (no filter, no special path)',
  (src) => {
    const send = fnBody(slice(src), 'chatSkinSendNow') + fnBody(slice(src), 'chatSkinSubmit');
    return !/startsWith\('\/'\)\s*\)\s*return/.test(send) && !/ptyRun\(/.test(send) && /submitToPty\(id, text\)/.test(send);
  },
  (src) => src.replace('const text = cs.input.value.replace', "if (cs.input.value.startsWith('/')) return;\n  const text = cs.input.value.replace"));

test('Enter sends, Shift+Enter breaks the line, and IME composition never sends', () => {
  const cond = /input\.addEventListener\('keydown', \(e\) => \{[\s\S]*?if \((e\.key !== 'Enter'[^)]*)\) return;/.exec(skin)?.[1];
  assert.ok(cond, 'the composer keydown guard must exist');
  // evaluate the real condition rather than re-describe it
  const skips = new Function('e', `return (${cond});`) as (e: Record<string, unknown>) => boolean;
  const ev = (o: Record<string, unknown>) => ({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13, ...o });
  assert.equal(skips(ev({})), false, 'plain Enter must send');
  assert.equal(skips(ev({ shiftKey: true })), true, 'Shift+Enter must break the line (the textarea default)');
  assert.equal(skips(ev({ isComposing: true })), true, 'Enter while composing confirms the candidate');
  assert.equal(skips(ev({ keyCode: 229 })), true, 'keyCode 229 covers engines that clear isComposing early');
  assert.equal(skips(ev({ key: 'a' })), true);
  assert.match(skin, /e\.preventDefault\(\);\n\s+chatSkinSendNow\(id, p\);/, 'the plain-Enter branch prevents default and sends');
  // negative control: a condition that forgot Shift would send on Shift+Enter
  const broken = new Function('e', `return (${cond.replace(/ \|\| e\.shiftKey/, '')});`) as (e: Record<string, unknown>) => boolean;
  assert.equal(broken(ev({ shiftKey: true })), false, 'control: without the shiftKey clause Shift+Enter would send');
});

guarded('Esc writes a lone ESC to the pty, only while something is running',
  (src) => {
    const s = slice(src);
    const intr = fnBody(s, 'chatSkinInterrupt');
    return /ptyWrite\(id, '\\x1b'\)/.test(intr) && /!chatSkinWorking\(p\)/.test(intr)
      && /e\.key !== 'Escape'[\s\S]{0,120}chatSkinInterrupt\(id, p\)/.test(s);
  },
  (src) => src.replace("window.glassShell.ptyWrite(id, '\\x1b');", "window.glassShell.ptyWrite(id, '\\x03');"));

// ── watch / unwatch follow the session and the pane's life ──────────────────

guarded('closing the pane or losing the pty unwatches the transcript',
  (src) => {
    const s = slice(src);
    const close = fnBody(src, 'closePane');
    return /chatSkinTeardown\(id, p\)/.test(close)
      && /chatSkinUnwatch\(id\)/.test(fnBody(s, 'chatSkinTeardown'))
      && /chatSkinTeardown\(id, p\)/.test(fnBody(s, 'chatSkinOnExit'))
      && /chatSkinOnExit\(m\.id, p\)/.test(/window\.glassShell\.onPtyExit\(\(m\) => \{[\s\S]*?\n\}\);/.exec(src)?.[0] ?? '');
  },
  (src) => src.replace('  chatSkinTeardown(id, p);   // stop tailing the transcript', '  // (teardown removed)   // stop tailing the transcript'));

guarded('the watch follows the sessionId: a new id replaces the watch, no id yet still watches dialogs, only leaving chat unwatches',
  (src) => {
    const sync = fnBody(slice(src), 'chatSkinSync');
    return /cs\.watched === want\) return/.test(sync)
      // '' = chat view without a session id yet (dialogs only); null = not watching at all
      && /p\.view === 'chat' && !p\.exited \? \(p\.sessionId \? String\(p\.sessionId\) : ''\) : null/.test(sync)
      && /cs\.watched !== null && want === null/.test(sync) && sync.indexOf('chatSkinUnwatch(id)') > 0
      && /chatSkinWatch\(id, want \|\| null\)/.test(sync)
      && sync.indexOf('chatSkinUnwatch(id)') < sync.indexOf('chatSkinWatch(id,');
  },
  (src) => src.replace('if (cs.watched === want) return;', 'if (cs.watched) return;'));

guarded('a transcript that is not there yet is "waiting", not an error: a new session has no file until its first message',
  (src) => /r && !r\.ok && r\.error === 'not-found'\) \{ chatSkinPaintState\(p\); return; \}/.test(fnBody(slice(src), 'chatSkinSync')),
  (src) => src.replace("r.error === 'not-found'", "r.error === 'nothing'"));

test('every place that learns, changes or forgets a session tells the skin (or the tick reconciles it)', () => {
  const hooks = (app.match(/chatSkinSessionChanged\(/g) || []).length;
  // title listener (×2: name match + process-tree correction), pulse "ended", restore, tick, recheck, definition
  assert.ok(hooks >= 7, `expected the adoption sites to call chatSkinSessionChanged, found ${hooks}`);
  const tick = fnBody(skin, 'chatSkinTick');
  assert.match(tick, /chatSkinEligible\(p\)[\s\S]*chatSkinSessionChanged\(id, p\)[\s\S]*chatSkinSync\(id, p\)/, 'the tick is the safety net for sites that do not call');
  // adoptUnidentified is exercised by sessionRestore.test.ts in isolation, so it relies on the tick on purpose
  assert.doesNotMatch(/function adoptUnidentified\(\) \{[\s\S]*?\n\}/.exec(app)?.[0] ?? '', /chatSkin\w*\(/);
  // negative control: a pane that is not a Claude pane is not eligible
  assert.match(fnBody(skin, 'chatSkinEligible'), /p\.kind === 'term' && !p\.exited/);
});

// ── the xterm is hidden without being destroyed or resized ──────────────────

guarded('hiding the xterm never uses display:none on its host, and no fit() runs while the skin is up',
  (src) => {
    const s = slice(src);
    const fits = [...s.matchAll(/\.fit\(\)/g)].length;
    const handBack = fnBody(s, 'chatSkinHandBack');
    const twrapDisplay = /twrap[^\n]*style\.display|\.twrap[^{]*\{[^}]*display:\s*none/;
    return fits === 1 && /\.fit\(\)/.test(handBack) && /p\.view === 'chat'/.test(handBack)
      && !twrapDisplay.test(s) && !twrapDisplay.test(css)
      && !/ptyResize\(/.test(s)
      && /\.pane\.termcard\.view-chat \.twrap \{ visibility: hidden; \}/.test(css);
  },
  (src) => src.replace('function chatSkinFocus(p) {', "function chatSkinFocus(p) {\n  p.el.querySelector('.twrap').style.display = 'none';"));

test('no CSS rule of the skin can punch through a hidden pane with an explicit visibility:visible', () => {
  const sk = css.slice(css.indexOf('/* ═══ Chat skin')).replace(/\/\*[\s\S]*?\*\//g, '');   // rules only: the prose explains the very mistake
  assert.ok(sk.length > 1500, 'the skin stylesheet block must exist');
  assert.doesNotMatch(sk, /visibility:\s*visible/, 'a child with visibility:visible shows through .panehidden (use inherit)');
  assert.match(sk, /\.pane\.termcard\.view-chat\.cs-strip \.twrap \{ visibility: inherit; \}/);
  // control: the pattern would catch the mistake
  assert.match(sk + '\n.x { visibility: visible; }', /visibility:\s*visible/);
});

test('the pty resize path stays the terminal\'s own (the skin adds no geometry push)', () => {
  assert.doesNotMatch(skin, /ptyResize/);
  // the only geometry push is the hand-back, after the overlay is gone
  const uses = [...skin.matchAll(/pushPtyGeom\(/g)].length;
  assert.equal(uses, 1);
  assert.match(fnBody(skin, 'chatSkinHandBack'), /pushPtyGeom\(id, p\)/);
});

// ── doors: the setting, the shortcut, the menu item; and no button on the tab ──────────────────────────

/** The old per-tab switch, in every spelling it ever had in the renderer and the stylesheet. */
const SWITCH_TRACES = /chatSkinMountToggle|chatSkinPaintToggle|chatSkinToggleFocused|\bchatSkinToggle\b|\bviewBtn\b|\btview\b/;
guarded('the tab carries no Chat/Terminal switch: no button is built, mounted, painted or wired anywhere in the renderer',
  (src) => !SWITCH_TRACES.test(src) && !/chatDefToggle|chatViewDefault/.test(src)
    && !/p\.tab\.insertBefore/.test(fnBody(src, 'createPane')),   // nothing is put next to the name of a terminal tab any more
  (src) => src.replace("  const tab = makeTab(id, name, 'term');\n  const p = { kind: 'term',", "  const tab = makeTab(id, name, 'term');\n  chatSkinMountToggle(id, { tab });\n  const p = { kind: 'term',"));
test('the stylesheet has no rule for the old tab switch, and the check catches one that comes back', () => {
  assert.doesNotMatch(css, SWITCH_TRACES);
  assert.match(css + '\n.tab .tview { width: 22px; }', SWITCH_TRACES, 'control: a .tview rule would be caught');
  assert.doesNotMatch(css, /\.tab \.tview|tview/);
});

guarded('the mode has its doors: a free accelerator and a menu item that flip the GLOBAL setting, and a Settings selector that writes it',
  (src) => {
    const accels = [...menu.matchAll(/accelerator: '([^']+)'/g)].map((m) => m[1]);
    const mine = /accelerator: '(CmdOrCtrl\+Shift\+L)', click: \(\) => intent\('toggleChatView'\)/.exec(menu)?.[1];
    const st = fnBody(src, 'openSettingsTab');
    return !!mine && accels.filter((a) => a === mine).length === 1
      && /case 'toggleChatView': void chatSkinToggleMode\(\); return;/.test(src)
      && /setSetting\('claudeView', mode\)/.test(fnBody(slice(src), 'chatSkinSetMode'))
      && /chatSkinSetMode\(claudeViewSel\.value\)/.test(st) && /claudeViewSel\.className = 'tinput'/.test(st);
  },
  (src) => src.replace("case 'toggleChatView': void chatSkinToggleMode(); return;", "case 'toggleChatView': chatSkinToggleFocused(); return;"));

guarded('the only writer of the mode is chatSkinSetMode, so a glance at the terminal ("Show terminal", "View in terminal") can never change it',
  (src) => {
    const writers = [...src.matchAll(/setSetting\('claudeView'/g)].length;
    const settingsWrite = /chatSkinSetMode\(claudeViewSel\.value\)/.test(fnBody(src, 'openSettingsTab'));
    const glance = `${fnBody(slice(src), 'chatSkinCardBuild')}\n${/alertBtn\.addEventListener\('click'[^\n]*\n/.exec(src)?.[0] ?? ''}${/stateBtn\.addEventListener\('click'[^\n]*\n/.exec(src)?.[0] ?? ''}`;
    return writers === 1 && settingsWrite && glance.length > 100 && !/chatSkinSetMode|chatSkinToggleMode|claudeView/.test(glance);
  },
  (src) => src.replace("alertBtn.addEventListener('click', () => chatSkinSetView(id, 'term'));", "alertBtn.addEventListener('click', () => chatSkinSetMode('terminal'));"));

guarded('the tab menu offers a way back ONLY to a tab that stepped out of the mode, and it follows the mode rather than flipping it',
  (src) => /chatSkinOutOfMode\(pane\)\) items\.push\(\{ label: t\(chatMode === 'chat' \? 'chat\.skin\.toChat' : 'chat\.skin\.toTerminal'\), value: 'chatView' \}\)/.test(src)
    && /pick === 'chatView'\) chatSkinFollowMode\(id\)/.test(src)
    && /const chatSkinOutOfMode = \(p\) => chatSkinEligible\(p\) && \(p\.view === 'chat'\) !== \(chatMode === 'chat'\);/.test(src)
    && /chatSkinSetView\(id, chatMode === 'chat' \? 'chat' : 'term'\)/.test(fnBody(slice(src), 'chatSkinFollowMode')),
  (src) => src.replace("if (pane.kind === 'term' && chatSkinOutOfMode(pane)) items.push", "if (pane.kind === 'term') items.push"));

/** The mode block of the real source, run against stand-ins: panes, a recorder for views, a recorder for stored settings. */
function modeHarness(src: string, stored: string | undefined = 'terminal') {
  const s = slice(src);
  const a = s.indexOf('let chatMode =');
  const b = s.indexOf('/* A tab that left the mode on purpose');
  assert.ok(a > 0 && b > a, 'the mode block was found');
  const eligible = fnBody(s, 'chatSkinEligible');
  assert.ok(eligible.length > 40);
  const calls: Array<[number, string]> = [];
  const writes: Array<[string, string]> = [];
  const toasts: string[] = [];
  const claude = { kind: 'term', isSession: true, view: 'term' };
  const panes = new Map<number, Record<string, unknown>>([
    [1, { ...claude }],                                                     // a Claude session in a terminal tab
    [2, { kind: 'term', cmd: 'zsh', view: 'term' }],                         // a plain shell: no Claude, nothing to show
    [3, { kind: 'file', view: 'term' }],                                     // a viewer tab
    [4, { ...claude, exited: true }],                                        // a Claude whose pty is gone
    [5, { kind: 'term', sessionId: 'abc', view: 'chat' }],                   // a second live Claude, already in chat
  ]);
  const glassShell = { shellConfig: async () => ({ claudeView: stored }), setSetting: async (k: string, v: string) => { writes.push([k, v]); } };
  const make = new Function('panes', 'chatSkinSetView', 'paneIsClaude', 'window', 'toast', 't',
    `${eligible}\n${s.slice(a, b)}\nreturn { chatSkinApplyMode, chatSkinSetMode, chatSkinToggleMode, mode: () => chatMode };`) as (...a: unknown[]) => {
      chatSkinApplyMode: (m: string) => void; chatSkinSetMode: (m: string, o?: { persist?: boolean }) => Promise<void>; chatSkinToggleMode: () => Promise<void>; mode: () => string };
  const api = make(panes, (id: number, v: string) => { calls.push([id, v]); return true; }, (cmd: unknown) => /claude/.test(String(cmd ?? '')), { glassShell }, (m: string) => toasts.push(m), (k: string) => k);
  return { ...api, calls, writes, toasts };
}
guarded('changing the mode moves every open Claude session and no plain terminal, viewer or ended session',
  (src) => {
    const h = modeHarness(src);
    h.chatSkinApplyMode('chat');
    const toChat = h.calls.map(([id, v]) => `${id}:${v}`).join(',');
    h.calls.length = 0;
    h.chatSkinApplyMode('terminal');
    return toChat === '1:chat,5:chat' && h.calls.map(([id, v]) => `${id}:${v}`).join(',') === '1:term,5:term';
  },
  (src) => src.replace("    if (!chatSkinEligible(p)) continue;   // a plain terminal (or a viewer) has no Claude behind it: it stays as it is\n", ''));
guarded('Settings and the shortcut go through one function: it applies the mode live, THEN stores it, and a refused value changes nothing',
  (src) => {
    return /chatSkinApplyMode\(mode\);[\s\S]*setSetting\('claudeView', mode\)/.test(fnBody(slice(src), 'chatSkinSetMode'))
      && /if \(mode !== 'chat' && mode !== 'terminal'\) return;/.test(fnBody(slice(src), 'chatSkinSetMode'));
  },
  (src) => src.replace("  if (mode !== 'chat' && mode !== 'terminal') return;\n  chatMode = mode;", '  chatMode = mode;'));
test('the shortcut flips the stored mode (read fresh), applies it to the open Claude sessions and says so; Settings writes the choice it was given', async () => {
  const run = async (src: string, stored: string | undefined) => {
    const h = modeHarness(src, stored);
    await h.chatSkinToggleMode();
    return h;
  };
  for (const [stored, next, view, said] of [['terminal', 'chat', 'chat', 'chat.skin.modeNowChat'], ['chat', 'terminal', 'term', 'chat.skin.modeNowTerminal'], [undefined, 'chat', 'chat', 'chat.skin.modeNowChat']] as const) {
    const h = await run(app, stored);
    assert.deepEqual(h.writes, [['claudeView', next]], `stored ${stored}: the setting is written`);
    assert.deepEqual(h.calls, [[1, view], [5, view]], `stored ${stored}: the open Claude sessions follow`);
    assert.deepEqual(h.toasts, [said], `stored ${stored}: the new mode is announced`);
    assert.equal(h.mode(), next);
  }
  // Settings: the operator's pick is written as given; a value that is neither is refused and changes nothing
  const set = modeHarness(app);
  await set.chatSkinSetMode('chat');
  await set.chatSkinSetMode('bogus');
  assert.deepEqual(set.writes, [['claudeView', 'chat']]);
  assert.equal(set.mode(), 'chat');
  // `persist: false` (the smoke run) applies without writing
  const dry = modeHarness(app);
  await dry.chatSkinSetMode('chat', { persist: false });
  assert.deepEqual(dry.writes, []);
  assert.deepEqual(dry.calls, [[1, 'chat'], [5, 'chat']]);
  // controls: a shortcut that still toggles the focused tab (no stored write), or one that never applies, is caught
  const noWrite = app.replace("  if (!opts || opts.persist !== false) await window.glassShell.setSetting('claudeView', mode);\n", '');
  assert.notEqual(noWrite, app);
  assert.deepEqual((await run(noWrite, 'terminal')).writes, []);
  const noApply = app.replace('  chatSkinApplyMode(mode);\n  for (const sub of', '  for (const sub of');
  assert.notEqual(noApply, app);
  assert.deepEqual((await run(noApply, 'terminal')).calls, []);
});

guarded('a session that BECOMES eligible takes the mode once, on the flip; nothing else in the tick moves a tab into chat, so a glance at the terminal is left alone',
  (src) => {
    const tick = fnBody(slice(src), 'chatSkinTick');
    const flip = /if \(ok !== p\.csEligible\) \{[\s\S]*?\n    \}\n/.exec(tick)?.[0] ?? '';
    return flip.length > 100 && /if \(ok && chatMode === 'chat' && p\.view !== 'chat'\) chatSkinSetView\(id, 'chat'\);/.test(flip)
      && [...tick.matchAll(/chatSkinSetView\(id, 'chat'\)/g)].length === 1
      && /chatSkinSessionChanged\(id, p\);\n      \/\*/.test(flip) && ![...fnBody(slice(src), 'chatSkinSessionChanged').matchAll(/chatSkinSetView\(id, 'chat'\)/g)].length;
  },
  (src) => src.replace("    const cs = p.chatSkin;\n    if (p.view !== 'chat' || !cs) continue;\n    chatSkinControls(p);", "    if (chatMode === 'chat' && ok && p.view !== 'chat') chatSkinSetView(id, 'chat');\n    const cs = p.chatSkin;\n    if (p.view !== 'chat' || !cs) continue;\n    chatSkinControls(p);"));

guarded('the mode opens every NEW Claude pane in its view, restored and resumed ones included, because they all come through createPane',
  (src) => {
    const dflt = fnBody(slice(src), 'chatSkinMaybeDefault');
    return /createPane/.test(fnBody(src, 'createPane')) && /chatSkinMaybeDefault\(id, p\)/.test(fnBody(src, 'createPane'))
      && /paneIsClaude\(p\.cmd\)/.test(dflt) && /claudeView === 'chat'/.test(dflt) && /chatSkinSetView\(id, 'chat'\)/.test(dflt)
      && !/chatViewDefault/.test(dflt)
      && /await createPane\(\{ name: ph\.name, cmd, cwd: ph\.cwd \|\| undefined \}\)/.test(src);   // restore/resume path: `claude --resume` via createPane
  },
  (src) => src.replace("(await window.glassShell.shellConfig()).claudeView === 'chat'", "(await window.glassShell.shellConfig()).claudeView === 'terminal'"));

// ── dialogs the chat cannot draw ────────────────────────────────────────────

guarded('a prompt event brings the REAL xterm forward with focus and a visible, announced notice; kind null puts the composer back',
  (src) => {
    const s = slice(src);
    const pr = fnBody(s, 'chatSkinPrompt');
    return /p\.term\.focus\(\)/.test(pr) && /toast\(t\(card \? 'chat\.skin\.needsYouHere' : 'chat\.skin\.needsYou', \{ name: chatSkinWho\(p\) \}\)\)/.test(pr) && /markActivity\(id\)/.test(pr)
      && /chatSkinFocus\(p\)/.test(pr)
      && /el\('div', 'cs-alert'\)/.test(s) && /alertEl\.setAttribute\('role', 'alert'\)/.test(s)
      && /classList\.toggle\('cs-strip'/.test(fnBody(s, 'chatSkinLayout'))
      && /cs\.input\.disabled = !!cs\.promptKind/.test(fnBody(s, 'chatSkinLayout'));
  },
  (src) => src.replace("alertEl.setAttribute('role', 'alert');", ''));

test('there is always a way back to the terminal, and a stalled turn offers it', () => {
  assert.match(skin, /alertBtn\.addEventListener\('click', \(\) => chatSkinSetView\(id, 'term'\)\)/, 'the notice button');
  assert.match(skin, /stateBtn\.addEventListener\('click', \(\) => chatSkinSetView\(id, 'term'\)\)/, 'and the error card');
  assert.match(skin, /const chatSkinOutOfMode = /, 'the tab has no icon, so the way back to the mode is the tab menu row that only a stepped-out tab gets');
  // the safety net: open turn + live pty + silent transcript -> the stalled notice
  const tick = fnBody(skin, 'chatSkinTick');
  assert.match(tick, /cs\.turnOpen && now - \(p\.lastPtyAt \|\| 0\) < CS_WORKING_MS \* 2 && quiet > CS_STALL_MS/);
  assert.match(fnBody(skin, 'chatSkinPaintAlert'), /chat\.skin\.stalled/);
  // lastPtyAt is recorded on every pty:data of the pane
  assert.match(/window\.glassShell\.onPtyData\(\(m\) => \{[\s\S]*?\n\}\);/.exec(app)?.[0] ?? '', /p\.lastPtyAt = Date\.now\(\)/);
});

test('the usage bar prefers this session\'s own numbers over the global statusline payload', () => {
  const paint = fnBody(skin, 'chatPaintUsage');
  assert.match(fnBody(skin, 'chatContextOf'), /Number\.isFinite\(cs\.ctxTokens\)/);
  assert.match(paint, /const model = cs\.model \|\| cs\.status\.model;/);
  assert.match(fnBody(skin, 'chatSkinRefreshStatus'), /gs\.chatStatus\(cs\.pane\.sessionId\)/);
  // an absent number is a dash, never a fabricated 0
  assert.match(fnBody(skin, 'chatApplyStatus'), /s\[k\] === undefined \|\| s\[k\] === null \|\| s\[k\] === ''\) continue;/);
});

// ── untrusted model text ────────────────────────────────────────────────────

test('model output never reaches the DOM as raw HTML', () => {
  const md = fnBody(skin, 'chatMarkdown');
  assert.match(md, /new marked\.Marked\(/);
  assert.doesNotMatch(md, /marked\.use\(/, 'the global marked must not be reconfigured');
  assert.match(md, /html\(tok\) \{ return chatEscape\(/);
  const san = fnBody(skin, 'chatSanitize');
  assert.match(san, /document\.createElement\('template'\)/);
  assert.match(san, /CHAT_DROP\.has\(tag\)/);
  assert.match(san, /\^\(https\?:\|mailto:\)/, 'only http(s) and mailto links survive');
  assert.match(san, /child\.removeAttribute\(a\.name\)/, 'no attribute (onerror, style, src…) survives');
  const tags = /const CHAT_TAGS = new Set\(\[([\s\S]*?)\]\)/.exec(skin)?.[1] ?? '';
  for (const bad of ['SCRIPT', 'IMG', 'IFRAME', 'STYLE', 'FORM', 'SVG']) assert.doesNotMatch(tags, new RegExp(`'${bad}'`), `${bad} must not be allowed`);
  assert.match(fnBody(skin, 'chatRender'), /chatSanitize\(chatMarkdown\(\)\.parse\(/);
  assert.match(fnBody(skin, 'chatRender'), /target\.replaceChildren\(frag\)/);
  // the only markup writes: the inert template, hljs output over textContent, and csIcon's holder
  // (an icon from the static ICONS table, never model text — a model-text write would still show up as a new name here)
  const direct = [...skin.matchAll(/(\w+(?:\.\w+)*)\.innerHTML\s*=/g)].map((m) => m[1]);
  assert.deepEqual(direct.sort(), ['code', 'holder', 'tpl'], `unexpected innerHTML writes: ${direct.join(', ')}`);
  // the operator's and the transcript's plain text go in as textContent
  assert.match(fnBody(skin, 'chatSkinUpsert'), /rec\.body\.textContent = text/);
  // links open in the system browser, never inside this window
  assert.match(skin, /e\.preventDefault\(\);\n\s+void window\.glassShell\.openExternal\(/);
  // negative control: an innerHTML of model text would be caught by the same list
  assert.notDeepEqual([...(skin + '\nrow.innerHTML = text;').matchAll(/(\w+(?:\.\w+)*)\.innerHTML\s*=/g)].map((m) => m[1]).sort(), ['b', 'code', 'holder', 'tpl']);
});

test('the markdown sanitizer, run for real, drops scripts, handlers and unsafe links', () => {
  // the browser DOM is not available here, so the policy tables are checked instead of the walk
  const drop = /const CHAT_DROP = new Set\(\[([\s\S]*?)\]\)/.exec(skin)?.[1] ?? '';
  for (const must of ['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'SVG']) assert.match(drop, new RegExp(`'${must}'`));
  assert.match(fnBody(skin, 'chatSanitize'), /tag === 'IMG'[\s\S]*alt/, 'a remote image is replaced by its alt text, never fetched');
});

// ── i18n and colours ────────────────────────────────────────────────────────

const loc = Object.fromEntries(['en', 'es', 'pt-br'].map((l) => [l, JSON.parse(read(`src/i18n/locales/${l}.json`)) as Record<string, string>]));

test('every key the skin, the menu and the settings row use exists in en, es and pt-br, with the same placeholders', () => {
  const used = new Set<string>([
    ...[...skin.matchAll(/\bt\('([A-Za-z.-]+)'/g)].map((m) => m[1]),
    ...[...skin.matchAll(/label: '(chat\.[A-Za-z.]+)'/g)].map((m) => m[1]),    // CHAT_FONTS labels
    ...[...skin.matchAll(/\['[A-Za-z]+', '(chat\.usage\.[A-Za-z]+)'/g)].map((m) => m[1]),   // CHAT_USAGE_FIELDS labels
    'menu.chatView', 'settings.claudeView', 'settings.claudeViewHint', 'settings.claudeView.chat', 'settings.claudeView.terminal',   // the Settings selector
    'chat.skin.modeNowChat', 'chat.skin.modeNowTerminal', 'chat.skin.toChat', 'chat.skin.toTerminal',   // the shortcut's toast, the tab menu's way back
    'settings.chatFont', 'settings.chatFontHint', 'settings.chatSize', 'settings.chatSizeHint', 'chat.settings.sample',   // the Settings rows for the chat's font and size
  ]);
  // keys built at run time: 'chat.skin.prompt.' + kind, 'chat.skin.tool.' + status
  const kinds = /const CHAT_PROMPT_KINDS = \[([^\]]+)\]/.exec(skin)?.[1].match(/'([a-z]+)'/g) ?? [];
  assert.ok(kinds.length >= 6, 'the prompt kinds of the contract');
  for (const k of kinds) used.add('chat.skin.prompt.' + k.slice(1, -1));
  for (const s of ['running', 'ok', 'error']) used.add('chat.skin.tool.' + s);
  for (const k of [...used].filter((u) => u.endsWith('.'))) used.delete(k);
  assert.ok(used.size >= 40, `expected the full chat vocabulary, found ${used.size}`);
  for (const l of Object.keys(loc)) {
    const missing = [...used].filter((k) => typeof loc[l][k] !== 'string' || !loc[l][k].trim());
    assert.deepEqual(missing, [], `${l}.json is missing: ${missing.join(', ')}`);
  }
  // control: a key nobody wrote is reported missing
  assert.equal(typeof loc.en['chat.skin.nope'], 'undefined');
  const keysOf = (l: string): string[] => Object.keys(loc[l]).filter((k) => k.startsWith('chat.')).sort();
  assert.deepEqual(keysOf('es'), keysOf('en'));
  assert.deepEqual(keysOf('pt-br'), keysOf('en'));
  const holes = (s: string): string => (s.match(/\{[a-zA-Z]+\}/g) || []).sort().join(',');
  for (const k of keysOf('en')) for (const l of ['es', 'pt-br']) assert.equal(holes(loc[l][k]), holes(loc.en[k]), `${l}.json ${k}: placeholders differ from en`);
});

test('the SDK pane\'s strings are gone from every locale', () => {
  for (const l of Object.keys(loc)) {
    const stale = Object.keys(loc[l]).filter((k) => /^(menu\.openChat|newtab\.chat|tab\.newChat|chat\.title|chat\.unavailable|chat\.perm\.|chat\.interrupted|chat\.turnError|chat\.exited|chat\.error\.)/.test(k));
    assert.deepEqual(stale, [], `${l}.json still carries ${stale.join(', ')}`);
  }
});

test('every colour the skin uses is a token (none minted in the skin\'s own rules), defined for both themes', () => {
  const tokens = ['--chat-user-bg', '--chat-user-line', '--chat-claude-bg', '--chat-claude-line', '--chat-code-bg', '--chat-tool-ink',
    // the redesign's own (each must resolve against body.light's ink/surface, hence re-declared there)
    '--chat-code-head', '--chat-out-bg', '--chat-row-hover', '--chat-table-head', '--chat-table-zebra', '--chat-quote-line', '--chat-composer-bg',
    '--chat-composer-line', '--chat-meter-track', '--chat-meter-fill', '--chat-focus', '--chat-float', '--chat-pop', '--chat-on-accent',
    // the status bar's own
    '--chat-meter-warn', '--chat-meter-hot', '--chat-warn-ink', '--chat-hot-ink', '--chat-bar-bg', '--chat-bar-line', '--chat-bar-sep'];
  const light = css.slice(css.indexOf('body.light {'));
  for (const tk of tokens) {
    assert.match(css, new RegExp(`:root \\{[^}]*${tk}:`), `${tk} must be minted in :root`);
    assert.match(light, new RegExp(`${tk}:`), `${tk} must be re-declared for body.light (a var() resolves where it is declared)`);
  }
  const sk = css.slice(css.indexOf('/* ═══ Chat skin')).replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(sk, /#[0-9a-fA-F]{3,8}\b/, 'no hex literal in the skin\'s rules');
  assert.doesNotMatch(sk, /\brgba?\(/, 'no raw rgb()/rgba() in the skin\'s rules');
  // control
  assert.match(sk + '\n.x { color: #fff; }', /#[0-9a-fA-F]{3,8}\b/);
});

/** The Settings screen's own function: the font and size of the chat live there and nowhere in the conversation. */
const settingsFn = (src: string): string => fnBody(src, 'openSettingsTab');
guarded('the chat font and size are chosen in Settings, in the same section as the Chat | Terminal selector (and step aside in Terminal), saved under the same two keys and applied live',
  (src) => {
    const st = settingsFn(src);
    const at = (needle: string): number => st.indexOf(needle);
    const def = at("row(wrap, t('settings.claudeView')");
    const font = at("row(wrap, t('settings.chatFont')");
    const size = at("row(wrap, t('settings.chatSize')");
    const next = at("row(wrap, t('settings.appFont')");
    // the same section: right after the view selector, before the next unrelated row
    const together = def > 0 && font > def && size > font && next > size && font - def < 3500;
    const fontHandler = /chatFontSel\.addEventListener\('change'[\s\S]*?\n    \}\);/.exec(st)?.[0] ?? '';
    const sizeHandler = /chatSizeSel\.addEventListener\('change'[\s\S]*?\n    \}\);/.exec(st)?.[0] ?? '';
    return together
      && /chatPrefs\.family = chatFontSel\.value/.test(fontHandler) && /chatApplyPrefs\(\)/.test(fontHandler) && /setSetting\('chatFontFamily', chatPrefs\.family\)/.test(fontHandler)
      && /chatPrefs\.size = v/.test(sizeHandler) && /chatApplyPrefs\(\)/.test(sizeHandler) && /setSetting\('chatFontSize', v\)/.test(sizeHandler)
      && /for \(const n of \[chatFontRow, chatSizeRow, chatSample\]\) n\.hidden = chatMode !== 'chat';/.test(st)   // only meaningful in Chat
      && /chatReadPrefs\(cfg\)/.test(st)   // seeded from the config this page was built from, not from whatever a chat view last read
      && /CHAT_FONTS\.map/.test(st) && /CHAT_SIZES\.map/.test(st);
  },
  // the live effect is lost: the font is saved but no open chat repaints until the next time it is entered
  (src) => src.replace("      chatPrefs.family = chatFontSel.value;\n      chatApplyPrefs();", "      chatPrefs.family = chatFontSel.value;"));


// ── integration: renderer ↔ preload ↔ main speak the same contract ──────────

/** The renderer's pane id IS the pty id: every call below passes the `panes` key, and main keys `skins` by the pty id. */
const contractHolds = (rend: string, pre: string, mn: string): boolean => {
  const chans = ['chatSkin:watch', 'chatSkin:unwatch', 'chatSkin:event', 'chatSkin:screen'];
  const events = ['reset', 'items', 'turn', 'usage', 'prompt', 'stream', 'missing', 'error'];
  const handler = /function chatSkinHandleEvent\(ev\) \{[\s\S]*?\n\}/.exec(rend)?.[0] ?? '';
  return chans.every((c) => pre.includes(`'${c}'`) && mn.includes(`'${c}'`))
    && /ipcMain\.handle\('chatSkin:watch'/.test(mn) && /ipcMain\.handle\('chatSkin:unwatch'/.test(mn)
    && /ipcMain\.on\('chatSkin:screen'/.test(mn) && /sender\.send\('chatSkin:event', ev\)/.test(mn)
    && events.every((e) => new RegExp(`type: '${e}'`).test(pre) && new RegExp(`case '${e}':`).test(handler))
    && /glassShell\.onChatSkinEvent\(chatSkinHandleEvent\)/.test(rend)
    && /gs\.chatSkinWatch\(id, want \|\| null\)/.test(rend) && /gs\.chatSkinUnwatch\(id\)/.test(rend)
    && /glassShell\.chatSkinScreen\(id, chatSkinScreenText\(p\)\)/.test(rend)
    && /const paneId = ev\.paneId|const id = ev\.paneId/.test(handler) && /panes\.get\(id\)/.test(handler)
    && /const id = nextId\+\+;\n\s+ptys\.set\(id, p\);/.test(mn)
    && /const id = await window\.glassShell\.ptySpawn\(/.test(rend) && /panes\.set\(id, p\)/.test(rend);
};
test('the renderer, the preload and main agree on every channel, event type and the pane id', () => {
  assert.ok(contractHolds(app, preload, main));
  // negative controls: a renamed channel, a dropped event case and a pane id that is not the pty id each break it
  assert.equal(contractHolds(app, preload.replaceAll("'chatSkin:event'", "'chatSkin:events'"), main), false);
  assert.equal(contractHolds(app.replace("case 'missing':", "case 'absent':"), preload, main), false);
  assert.equal(contractHolds(app, preload, main.replace('const id = nextId++;', 'const id = nextId++ + 1;')), false);
});

test('main\'s watch accepts a null session id (dialogs only) and keeps the dialog monitor when the id arrives', () => {
  const w = /ipcMain\.handle\('chatSkin:watch'[\s\S]*?\n\}\);/.exec(main)?.[0] ?? '';
  assert.match(w, /sessionId: string \| null/);
  assert.match(w, /if \(!transcript\) return \{ ok: true, file: '' \}/);
  assert.match(w, /if \(!k\) \{[\s\S]*createPromptMonitor[\s\S]*skins\.set\(id, k\)/, 'the monitor is created once, not per watch');
  assert.match(w, /monitor\.push\(seen\)/, 'a dialog already on screen is not forgotten');
  assert.match(preload, /chatSkinWatch: \(paneId: number, sessionId: string \| null\)/);
  assert.doesNotMatch(w.replace('if (!k) {', 'if (true) {'), /if \(!k\) \{/, 'control: the reuse guard is what the first check reads');
});

// ── the dialog detector, against what this CLI really draws ─────────────────

/* Claude Code 2.1 places words with an ABSOLUTE column (`ESC[<n>G`) and draws the folder-trust dialog
   with no numbers. Hand-written from a capture's structure; neutral folder name. */
const TRUST_RAW = '\x1b[2G\x1b[38;5;220m\x1b[1mAccessing\x1b[12Gworkspace:\x1b[22m\x1b[39m\r\r\n\r\r\n\x1b[2G\x1b[1m/tmp/example-folder\x1b[22m\r\r\n\r\r\n'
  + '\x1b[2GQuick\x1b[8Gsafety\x1b[15Gcheck:\x1b[22GIs\x1b[25Gthis\x1b[30Ga\x1b[32Gproject\x1b[40Gyou\x1b[44Gcreated\x1b[52Gor\x1b[55Gone\x1b[59Gyou\x1b[63Gtrust?\r\r\n\r\r\n'
  + '\x1b[2G\x1b[38;5;246mSecurity\x1b[11Gguide\x1b[39m\r\r\n\r\r\n\x1b[2G\x1b[38;5;153m❯\x1b[4GNo,\x1b[8Gexit\x1b[39m\r\r\n\x1b[4GYes,\x1b[9GI\x1b[11Gtrust\x1b[17Gthis\x1b[22Gfolder\r\r\n\r\r\n'
  + '\x1b[2G\x1b[38;5;246mEnter\x1b[8Gto\x1b[11Gconfirm\x1b[19G·\x1b[21GEsc\x1b[25Gto\x1b[28Gcancel\x1b[39m\r\r\n\x1b[1C\x1b[4A';
/* Moving the selection repaints only the two option lines — the footer is NOT sent again. */
const TRUST_MOVED = '\x1b[1D\x1b[4B\r\x1b[1C\x1b[4A \x1b[4GNo, exit\r\x1b[1C\x1b[1B\x1b[38;5;153m❯\x1b[4GYes, I trust this folder\x1b[39m\r\r\n\r\n\r\n\x1b[1C\x1b[3A';
const TRUST_SCREEN = ['Accessing workspace:', '/tmp/example-folder', 'Quick safety check: Is this a project you created or one you trust?', 'Security guide',
  '   No, exit', ' ❯ Yes, I trust this folder', '', ' Enter to confirm · Esc to cancel'].join('\n');
const COMPOSER_SCREEN = ['Do you want me to continue?', '─'.repeat(60), '❯ Try "fix lint errors"', '─'.repeat(60), ' ⏵⏵ bypass permissions on (shift+tab to cycle)'].join('\n');

test('the unnumbered folder-trust dialog is recognised once the absolute-column words are joined', () => {
  assert.equal(detectTuiPrompt(TRUST_RAW)?.kind, 'trust');
  assert.match(detectTuiPrompt(TRUST_RAW)?.hint ?? '', /Quick safety check/);
  // negative control: without the words the same bytes read as noise ("Quicksafetycheck…")
  assert.equal(detectTuiPrompt(TRUST_RAW.replace(/\x1b\[\d+G/g, '')), null);
});

test('the idle composer is not a dialog, even right under a question Claude asked', () => {
  assert.equal(detectTuiPrompt(COMPOSER_SCREEN), null);
  assert.equal(detectTuiPrompt(COMPOSER_SCREEN.replace('Do you want me to continue?', 'Which option do you prefer?')), null);
  assert.equal(detectTuiPrompt(TRUST_SCREEN)?.kind, 'trust', 'control: the same detector does see a real dialog');
});

test('a differential repaint hides the dialog from the stream but not from the screen — which is why the screen is what main reads', () => {
  assert.equal(detectTuiPrompt(TRUST_RAW + TRUST_MOVED), null, 'the raw stream loses it (the footer was not repainted)');
  assert.equal(detectTuiPrompt(TRUST_SCREEN)?.kind, 'trust', 'the screen still shows it');
  const seen: Array<string | null> = [];
  const m = createPromptMonitor({ onChange: (k) => seen.push(k), setTimer: (fn) => { fn(); return 0; }, clearTimer: () => undefined });
  m.screen(TRUST_SCREEN);
  m.screen(TRUST_SCREEN.replace(' ❯ Yes', '   Yes').replace('   No, exit', ' ❯ No, exit'));   // the cursor moved; still a dialog, no flicker
  assert.deepEqual(seen, ['trust'], 'one event, no null in between');
  m.screen(COMPOSER_SCREEN);
  assert.deepEqual(seen, ['trust', null]);
  // control: the stream-fed monitor is the one that flickers
  const seen2: Array<string | null> = [];
  const m2 = createPromptMonitor({ onChange: (k) => seen2.push(k), setTimer: (fn) => { fn(); return 0; }, clearTimer: () => undefined });
  m2.push(TRUST_RAW); m2.push(TRUST_MOVED);
  assert.deepEqual(seen2, ['trust', null]);
});

test('the renderer sends screens only while the chat view is up and watching, after xterm parsed the bytes', () => {
  const fn = fnBody(skin, 'chatSkinScreenSoon');
  assert.match(fn, /cs\.watched === null \|\| p\.view !== 'chat'/);
  assert.match(fn, /clearTimeout\(cs\.screenTimer\)/, 'every chunk pushes the snapshot back to the end of the repaint…');
  assert.match(fn, /cs\.screenSince \+ CS_SCREEN_MAX_MS - now/, '…but never past the ceiling after the first unsent byte');
  assert.match(app, /p\.term\.write\(m\.data, p\.chatSkin && p\.view === 'chat' \? \(\) => \{ chatSkinFrameState\(p\.chatSkin, m\.data\); chatSkinScreenSoon\(m\.id, p\); \} : undefined\)/);
  assert.match(main, /if \(sk && !sk\.screenFed\) sk\.monitor\.push\(data\)/, 'once a screen arrives the raw stream stops feeding the monitor');
  assert.match(main, /k\.sender !== e\.sender/, 'only the window that owns the watch can feed it');
});

// ── the chat view changes nothing about who a session is or how it is reached ──

guarded('in chat view a session is still found by name/id, written to by the bus and the primary, closed, and restored — none of it reads the view',
  (src) => {
    const by = /const byName = [\s\S]*?\n\};/.exec(src)?.[0] ?? '';
    const amb = /const ambiguous = [\s\S]*?;\n/.exec(src)?.[0] ?? '';
    const send = /case 'sendByName': \{[\s\S]*?\n    \}\n/.exec(src)?.[0] ?? '';
    const prim = fnBody(src, 'runInPrimary');
    const close = fnBody(src, 'closePane');
    const snap = fnBody(src, 'sessionsSnapshot');
    const noView = (x: string): boolean => x.length > 40 && !/\.view\b|chatSkin(?!Teardown)/.test(x);
    return noView(by) && noView(amb) && noView(send) && noView(prim) && noView(snap)
      && /submitToPty\(hit\[0\], m\.text\)/.test(send) && /submitToPty\(hit\[0\], slash\)/.test(prim)
      && close.indexOf('chatSkinTeardown(id, p)') > 0 && close.indexOf('chatSkinTeardown(id, p)') < close.indexOf('window.glassShell.ptyKill(id)')
      && /panes\.delete\(id\)/.test(close);
  },
  (src) => src.replace('submitToPty(hit[0], m.text);\n      // a bus send', 'if (panes.get(hit[0]).view === "chat") return;\n      submitToPty(hit[0], m.text);\n      // a bus send'));

guarded('every route that opens a Claude session — new, resume, restore, bus, primary — goes through createPane, where the chat default is applied',
  (src) => {
    const cp = fnBody(src, 'createPane');
    return /void chatSkinMaybeDefault\(id, p\)/.test(cp)
      && !/chatSkinMaybeDefault\(/.test(src.replace(cp, '').replace(skin, ''))
      && (src.match(/createPane\(\{[^}]*cmd:/g) || []).length >= 6;
  },
  (src) => src.replace('void chatSkinMaybeDefault(id, p);', ''));

// ── the end-to-end smoke gate stays honest ──────────────────────────────────

const gateHolds = (src: string): boolean => {
    const g = /async function chatViewSmoke[\s\S]*?\n\}\n/.exec(src)?.[0] ?? '';
    return /show: !\(SMOKE \|\| CHAT_SHOT\)/.test(src)
      && /AIOS_SMOKE_CHAT/.test(g) && /strict \? \{ status: 'failed'/.test(g) && /status: 'skipped'/.test(g)
      && /--model haiku/.test(g) && /mkdtempSync\(path\.join\(tmpRoot, 'aios-smoke-chat-'\)\)/.test(g)
      && /\} finally \{[\s\S]*closePane\([\s\S]*rmSync\(dir[\s\S]*rmSync\(tdir/.test(g)
      && /path\.basename\(dir\) === `aios-smoke-chat-\$\{tag\}`/.test(g)
      && /path\.dirname\(tdir\) === projects/.test(g) && /isSymbolicLink\(\)/.test(g)
      && /chatSkinSetMode\('chat', \{ persist: false \}\)/.test(g) && /chatSkinSetMode\(\$\{JSON\.stringify\(priorMode\)\}, \{ persist: false \}\)/.test(g) && !/\.click\(\); return p\.view/.test(g) && /KeyboardEvent\('keydown', \{ key: 'Enter'/.test(g)
      && /app\.exit\(ok && assets\.ok && chat\.status !== 'failed' \? 0 : 1\)/.test(src)
      && /smokeUserData = path\.join\(os\.tmpdir\(\), 'aios-smoke-userdata'\)/.test(src);
};
test('the real-session smoke gate: hidden window, skipped without claude, strict on request, always cleans up, deletes only what it can name', () => {
  assert.ok(gateHolds(main));
  assert.equal(gateHolds(main.replace('path.dirname(tdir) === projects', 'true')), false, 'control: a transcript folder check that can be bypassed');
  assert.equal(gateHolds(main.replace('} finally {\n    // CLEANUP', '} catch (e2) {\n    // CLEANUP')), false, 'control: cleanup that only runs on success');
});

// ── the hidden-window screenshot harness (--chat-shot) ──────────────────────
// A QA mode whose one promise is "never shows a window". Everything it does is invisible to the
// unit level (a visible window still captures fine), so the promise is pinned in the source, each
// guard with a negative control, plus the fixture the harness renders.

const runner = read('scripts/chat-shot.mjs');
const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
const chatShotBlock = (src: string): string => {
  const a = src.indexOf('/* ── CHAT SHOT');
  const b = src.indexOf('/* Every session the App creates');
  return a >= 0 && b > a ? src.slice(a, b) : '';
};
const shotBlock = chatShotBlock(main);

test('chat-shot: the window is created hidden, the lock makes any later show a no-op, and nothing in the mode shows it', () => {
  const holds = (src: string): boolean => {
    const win = /new BrowserWindow\(\{[\s\S]*?\n  \}\);/.exec(src)?.[0] ?? '';
    const lock = /function lockWindowHidden\(win: BrowserWindow\): void \{[\s\S]*?\n\}/.exec(src)?.[0] ?? '';
    return /show: !\(SMOKE \|\| CHAT_SHOT\)/.test(win)
      && /show: noop/.test(lock) && /showInactive: noop/.test(lock) && /focus: noop/.test(lock) && /win\.on\('show', \(\) => \{[^}]*win\.hide\(\)/.test(lock)
      && /if \(CHAT_SHOT\) \{ lockWindowHidden\(win\); void runChatShot\(win\); return; \}/.test(src)
      && !/\.show\(\)|showInactive\(\)|\.focus\(\)/.test(chatShotBlock(src).replace(lock, ''))
      && /if \(!\(SMOKE \|\| CHAT_SHOT\) && mainWin/.test(src);   // the Dock's activate handler: a smoke or shot run never shows a window
  };
  assert.ok(holds(main), 'the hidden-window guarantees must hold on the real source');
  assert.equal(holds(main.replace('show: !(SMOKE || CHAT_SHOT)', 'show: !SMOKE')), false, 'control: a window that is shown in chat-shot mode');
  assert.equal(holds(main.replace("win.on('show', () => { if (!win.isDestroyed()) win.hide(); });", '')), false, 'control: no re-hide if something shows it');
  assert.equal(holds(main.replace('void runChatShot(win); return; }', 'void runChatShot(win); }')), false, 'control: the mode falls through into the normal flow');
});

test('smoke: a packaged or source --smoke run is headless on macOS — no Dock activation, no activate-handler show', () => {
  const holds = (src: string): boolean => /if \(SMOKE && process\.platform === 'darwin'\) \{ try \{ app\.setActivationPolicy\('accessory'\)/.test(src)
    && /if \(!\(SMOKE \|\| CHAT_SHOT\) && mainWin && !mainWin\.isDestroyed\(\)\) \{ mainWin\.show\(\); mainWin\.focus\(\); \}/.test(src);
  assert.ok(holds(main));
  assert.equal(holds(main.replace("if (SMOKE && process.platform === 'darwin') { try { app.setActivationPolicy('accessory')", "if (false) { try { app.setActivationPolicy('accessory')")), false, 'control: a smoke run that shows a Dock icon');
  assert.equal(holds(main.replace('if (!(SMOKE || CHAT_SHOT) && mainWin', 'if (!CHAT_SHOT && mainWin')), false, 'control: an activate event during a smoke run shows the window');
});

// ── the chat view's assets, inside whatever the app was loaded from ─────────

test('smoke: the chat-assets gate always runs, never skips, and a failure fails the run; verify:package demands its OK line', () => {
  const verify = read('scripts/verify-package.mjs');
  const gate = (src: string): boolean => {
    const g = /async function chatAssetsSmoke[\s\S]*?\n\}\n/.exec(src)?.[0] ?? '';
    return /marked\.Marked/.test(g) && /window\.hljs/.test(g) && /chatSkinWatch/.test(g) && /\.cs-/.test(g)
      && /chatRender\(t,/.test(g) && /pre code\.hljs span/.test(g) && /onerror/.test(g) && /javascript:/.test(g)
      && /app\.isPackaged/.test(g) && /app\.getAppPath\(\)/.test(g)
      && /assets = await chatAssetsSmoke\(win\)/.test(src) && /if \(ok && assets\.ok\) chat = await chatViewSmoke/.test(src)
      && !/skipped/.test(g);
  };
  assert.ok(gate(main));
  assert.equal(gate(main.replace("o.hljs = !!(window.hljs && window.hljs.getLanguage && window.hljs.getLanguage('javascript'));", '')), false, 'control: a gate that does not look for the highlighter');
  assert.equal(gate(main.replace('if (ok && assets.ok) chat = await chatViewSmoke', 'if (ok) chat = await chatViewSmoke')), false, 'control: the real-session gate runs even when the assets gate failed');
  const live = (src: string, name: string): string => new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}\\n`).exec(src)?.[0] ?? '';
  const proven = (src: string, name: string): boolean => /if \(chatAssetsProven\(out, label\)\) ok\(/.test(live(src, name));   // the packaged smoke of that platform only passes with the line
  const pins = (src: string): boolean => /chat assets OK/.test(src) && /g\.assets/.test(src) && /AIOS_SMOKE_CHAT === '1' && g\.view !== 'ran'/.test(src)
    && /SMOKE_TIMEOUT_MS/.test(src) && /killTree\(p\)/.test(src)
    && proven(src, 'checkLiveLinux') && proven(src, 'checkLiveWindows');
  assert.ok(pins(verify));
  for (const fn of ['checkLiveLinux', 'checkLiveWindows']) {
    const f = live(verify, fn);
    assert.ok(f.length > 200, `${fn} was found`);
    assert.equal(pins(verify.replace(f, f.replace('if (chatAssetsProven(out, label)) ok(', 'ok('))), false, `control: ${fn} passes without proving the chat assets`);
  }
  assert.equal(pins(verify.replace('if (!g.assets) {', 'if (false) {').replace(/g\.assets/g, 'g.assetz')), false, 'control: verify:package passes without proving the chat assets');
  assert.equal(pins(verify.replace(/killTree\(p\)/g, "p.kill('SIGKILL')")), false, 'control: a harness kill that leaves the claude session behind');
});

test('verify:package on Linux and Windows: a smoke that exited 0 without "chat assets OK" is a failure, one with it is not, and the chat view line is only reported', () => {
  const verify = read('scripts/verify-package.mjs');
  const run = (src: string, out: string): { returned: boolean; failures: string[]; printed: string[] } => {
    const failures: string[] = []; const printed: string[] = [];
    const make = new Function('fail', 'console', `${fnBody(src, 'chatGateLines')}\n${fnBody(src, 'chatAssetsProven')}\nreturn chatAssetsProven;`) as (f: (m: string) => void, c: { log: (m: string) => void }) => (o: string, l: string) => boolean;
    const returned = make((m) => failures.push(m), { log: (m) => printed.push(m) })(out, 'linux-unpacked');
    return { returned, failures, printed };
  };
  const assetsLine = 'shell-smoke: chat assets OK ✓ — marked, highlight.js, stylesheet, preload bridge and sanitizer all work from where this build was loaded';
  const base = 'shell-smoke: window + pty OK ✓\n';
  const holds = (src: string): boolean => {
    const good = run(src, `${base}shell-smoke: chat assets — isPackaged=true\n${assetsLine}\nshell-smoke: chat view SKIPPED — no login\n`);
    const missing = run(src, base);
    const failed = run(src, `${base}shell-smoke: chat assets FAILED — highlight.js did not load\n`);
    return good.returned && good.failures.length === 0 && good.printed.length === 2 && good.printed.some((l) => /chat view SKIPPED/.test(l))   // reported, not required
      && !missing.returned && missing.failures.length === 1 && /never printed "chat assets OK"/.test(missing.failures[0])
      && !failed.returned && failed.failures.length === 1 && failed.printed.length === 1;
  };
  assert.ok(holds(verify), 'the helper must hold on the real script');
  assert.equal(holds(verify.replace('if (!g.assets) fail(', 'if (false) fail(')), false, 'control: a missing line is not a failure');
  assert.equal(holds(verify.replace("/^shell-smoke: chat assets OK/.test(l)", "/^shell-smoke: chat assets/.test(l)")), false, 'control: a FAILED line would count as proof');
});

test('chat-shot: skips the single-instance lock, the bus, the watchers and the updater, like --shot and --eval', () => {
  const holds = (src: string): boolean => /if \(!\(SMOKE \|\| CHAT_SHOT\) && !app\.requestSingleInstanceLock\(\)\)/.test(src)
    && /if \(!SMOKE && !SHOT && !CHAT_SHOT\) setupExplorerWatch\(win\)/.test(src)
    && /if \(!SMOKE && !SHOT && !CHAT_SHOT\) setupClaudeConfigWatch\(win\)/.test(src)
    && /if \(!SMOKE && !SHOT && !EVAL && !CHAT_SHOT\) initCommandBus\(/.test(src)
    && /if \(!SMOKE && !SHOT && !EVAL && !CHAT_SHOT\) initAutoUpdater\(/.test(src)
    && /if \(!SMOKE && !SHOT && !EVAL && !CHAT_SHOT\) \{\s*const stopCaffeine/.test(src)
    && /if \(!SMOKE && !SHOT && !EVAL && !CHAT_SHOT\) \{\s*try \{\s*const r = aios\.seedClaudeDefaults/.test(src);
  assert.ok(holds(main));
  assert.equal(holds(main.replace('!(SMOKE || CHAT_SHOT) && !app.requestSingleInstanceLock()', '!SMOKE && !app.requestSingleInstanceLock()')), false, 'control: the lock is taken, so a QA run would quit the moment the App is open');
  assert.equal(holds(main.replace('!SHOT && !EVAL && !CHAT_SHOT) initCommandBus(', '!SHOT && !EVAL) initCommandBus(')), false, 'control: the bus would fulfil real spawn requests');
});

test('chat-shot: 1280x860 CSS px at 2x, throwaway userData, a 2x switch set before ready, and a global timeout', () => {
  const holds = (src: string): boolean => {
    const top = src.slice(0, src.indexOf('const ptys = new Map'));
    return /CHAT_SHOT_SIZE = \{ width: 1280, height: 860 \}/.test(top)
      && /if \(CHAT_SHOT\) \{\s*\/\*[\s\S]*?app\.commandLine\.appendSwitch\('force-device-scale-factor', '2'\)/.test(top)
      && /useContentSize: CHAT_SHOT/.test(src)
      && /backgroundThrottling: false/.test(src)
      && /--user-data-dir must be an existing folder under/.test(top) && /process\.exit\(1\)/.test(top)
      && /mkdtempSync\(path\.join\(os\.tmpdir\(\), 'aios-chatshot-ud-'\)\)/.test(top)
      && /setTimeout\(\(\) => fail\('timed out after 300 s'\), 300_000\)/.test(chatShotBlock(src))
      && /finish\(0\)/.test(chatShotBlock(src)) && /app\.exit\(code\)/.test(chatShotBlock(src));
  };
  assert.ok(holds(main));
  assert.equal(holds(main.replace("appendSwitch('force-device-scale-factor', '2')", "appendSwitch('force-device-scale-factor', '1')")), false, 'control: a 1x capture');
  assert.equal(holds(main.replace("'aios-chatshot-ud-'", "'aios-chatshot-'")), false, 'control: userData named something the cleanup would not recognise');
  assert.equal(holds(main.replace('300_000', '3_000_000')), false, 'control: a timeout nobody would wait for');
});

test('chat-shot: the renderer driver only feeds the skin and the xterm — it never writes to the pty', () => {
  const driver = /const CHAT_SHOT_DRIVER = String\.raw`[\s\S]*?\n\}\)\(\)`;/.exec(main)?.[0] ?? '';
  assert.ok(driver.length > 1500, 'the driver was found');
  assert.ok(/chatSkinHandleEvent\(/.test(driver) && /p\.term\.write\(/.test(driver));
  assert.equal(/ptyWrite|submitToPty|ptyRun\(|chatSkinSendNow/.test(driver), false, 'the driver must never type into the pty');
  assert.equal(/ptyWrite|submitToPty/.test(driver.replace('p.term.write(', 'ptyWrite(')), true, 'control: the pattern does catch a pty write');
  assert.ok(/noProfile: true/.test(driver) && /cmd: 'cat'/.test(driver), 'a bare shell running cat, never a real claude');
});

test('chat-shot: the fake watch is settled before the fixture is injected, and the choice is written down', () => {
  const holds = (src: string): boolean => {
    const open = src.indexOf('async open(o)');
    const apply = src.indexOf('async apply(id, spec)');
    const i = src.indexOf('await window.glassShell.chatSkinWatch(id, FAKE_SESSION)');
    return open > 0 && i > open && i < apply && /THE FAKE SESSION, AND THE WATCH THAT COMES BACK/.test(src);
  };
  assert.ok(holds(main));
  assert.equal(holds(main.replace('await window.glassShell.chatSkinWatch(id, FAKE_SESSION);', '')), false, 'control: injecting while the app\'s own watch can still answer');
});

test('chat-shot: the runner isolates HOME + userData, turns the bus off, launches --chat-shot hidden and deletes only its own temp folders', () => {
  const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const holds = (src: string): boolean => /demo\.mjs'\), '--build-only', '--out', home/.test(src)
    && /AIOS_BUS_DISABLED: '1'/.test(src) && /HOME: home/.test(src)
    && /`--user-data-dir=\$\{userData\}`/.test(src) && /`--chat-shot=\$\{out\}`/.test(src) && /--use-mock-keychain/.test(src)
    && /real\.startsWith\(tmp \+ path\.sep\) && path\.basename\(real\)\.startsWith\(PREFIX\)/.test(src)
    && /const cleanup = \(\) => \{ for \(const d of created\.splice\(0\)\) if \(isOurTemp\(d\)\)/.test(src)
    && !/--shot|--eval|--smoke|\.dev-userdata|pkill|killall/.test(code(src));
  assert.ok(holds(runner));
  assert.equal(holds(runner.replace("AIOS_BUS_DISABLED: '1'", "AIOS_BUS_DISABLED: '0'")), false, 'control: the bus left on');
  assert.equal(holds(runner.replace('path.basename(real).startsWith(PREFIX)', 'true')), false, 'control: a cleanup that deletes any temp folder');
  assert.equal(holds(runner.replace('`--user-data-dir=${userData}`', "'--user-data-dir=.dev-userdata'")), false, 'control: the developer userData');
  assert.equal(holds(runner.replace("'--use-mock-keychain',", "'--use-mock-keychain', '--eval=1',")), false, 'control: a visible-window flag');
  assert.equal(pkg.scripts['chat:shot'], 'npm run compile && node scripts/chat-shot.mjs');
});

interface FxTool { id: string; name: string; summary: string; status: string; output?: string }
interface FxItem { uuid: string; role: string; text?: string; tool?: FxTool }
interface FxEvent { type: string; items?: FxItem[]; kind?: string; open?: boolean; [k: string]: unknown }
interface FxShot { name: string; theme?: string; events?: Array<string | FxEvent>; composer?: string; terminal?: string; js?: string | string[]; size?: { width: number; height: number }; layout?: string }
const fixture = JSON.parse(read('src/test/fixtures/chat-shot.json')) as { version: number; setup?: string | string[]; streams: Record<string, FxEvent[]>; shots: FxShot[] };

test('chat-shot fixture: parses, has the minimum shots, and every shot resolves to real streams', () => {
  assert.equal(fixture.version, 1);
  const names = fixture.shots.map((s) => s.name);
  for (const n of ['chat-dark', 'chat-light', 'attention-dark', 'attention-light', 'empty-dark']) assert.ok(names.includes(n), `missing shot ${n}`);
  assert.equal(new Set(names).size, names.length, 'shot names are unique (they become file names)');
  for (const s of fixture.shots) {
    assert.match(s.name, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/);
    for (const e of s.events ?? []) assert.ok(typeof e === 'string' ? Array.isArray(fixture.streams[e]) : typeof e.type === 'string', `${s.name}: bad event ${JSON.stringify(e).slice(0, 60)}`);
  }
  const byName = (n: string): FxShot => fixture.shots.find((s) => s.name === n) as FxShot;
  assert.equal(byName('chat-dark').theme, 'dark');
  assert.equal(byName('chat-light').theme, 'light');
  for (const n of ['chat-dark', 'chat-light']) assert.ok(byName(n).composer, `${n} has text in the composer`);
  for (const n of ['attention-dark', 'attention-light']) assert.ok(byName(n).terminal && (byName(n).events ?? []).includes('attention-prompt'), `${n} shows a dialog in the xterm and fires a prompt event`);
  assert.ok(fixture.shots.some((s) => s.js), 'at least one shot demonstrates per-shot js');
  assert.ok(fixture.shots.some((s) => s.size), 'at least one shot demonstrates a size override');
});

test('chat-shot fixture: the conversation covers markdown, three tool states with output, usage, and an open turn', () => {
  const ev = fixture.streams.conversation;
  const items = ev.filter((e) => e.type === 'items').flatMap((e) => e.items ?? []);
  assert.ok(items.filter((i) => i.role === 'user').length >= 2 && items.filter((i) => i.role === 'user').length <= 3, '2 or 3 operator messages');
  const md = items.filter((i) => i.role === 'assistant').map((i) => i.text ?? '').join('\n');
  for (const [what, re] of [['h2', /^## /m], ['h3', /^### /m], ['bullets', /^- /m], ['numbered list', /^1\. /m], ['inline code', /`[^`\n]+`/], ['ts block', /```ts\n/], ['bash block', /```bash\n/],
    ['3-column table', /^\|[^|\n]+\|[^|\n]+\|[^|\n]+\|$/m], ['blockquote', /^> /m], ['link', /\[[^\]]+\]\(https?:\/\/[^)]+\)/]] as Array<[string, RegExp]>) assert.match(md, re, `markdown: ${what}`);
  const tools = items.filter((i) => i.role === 'tool').map((i) => i.tool as FxTool);
  assert.deepEqual([...new Set(tools.map((t) => t.status))].sort(), ['error', 'ok', 'running']);
  for (const t of tools) { assert.ok(t.summary, `${t.name} has a summary`); assert.ok((t.output ?? '').split('\n').length >= 2, `${t.name} has multi-line output`); }
  const status = ev.find((e) => e.type === 'status') as FxEvent;
  assert.ok(typeof status.fiveHourPct === 'number' && typeof status.sevenDayPct === 'number' && status.model && status.effort);
  const usage = ev.find((e) => e.type === 'usage') as FxEvent;
  assert.ok(Number.isFinite(usage.contextTokens) && usage.model);
  assert.equal((ev[ev.length - 1] as FxEvent).open, true, 'the turn is left open: Claude is working');
  const prompt = fixture.streams['attention-prompt'][0];
  assert.ok(prompt.type === 'prompt' && (prompt.kind === 'permission' || prompt.kind === 'trust'));
});

test('chat-shot fixture: neutral by construction — no hex colors, no personal paths, nothing copied from a real vault', () => {
  const raw = read('src/test/fixtures/chat-shot.json');
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(raw), false);
  assert.equal(/\/Users\/|\/home\/|C:\\\\|@gmail|\.aios\/|vault/i.test(raw), false);
});

// ── the "boxes" redesign: what it must never loosen ─────────────────────────

guarded('the code header and the copy button are built AFTER the sanitiser, as DOM — a <button> can never come from model output',
  (src) => {
    const s = slice(src);
    const render = fnBody(s, 'chatRender');
    const deco = fnBody(s, 'chatDecorate');
    const tags = /const CHAT_TAGS = new Set\(\[([\s\S]*?)\]\)/.exec(s)?.[1] ?? '';
    return render.indexOf('chatSanitize(') > 0 && render.indexOf('chatSanitize(') < render.indexOf('chatDecorate(frag)')
      && render.indexOf('chatDecorate(frag)') < render.indexOf('target.replaceChildren(frag)')
      && /el\('button', 'cm-copy'\)/.test(deco) && !/innerHTML/.test(deco) && !/BUTTON/.test(tags)
      && /glassShell\.copyText\(text\)/.test(deco) && /chat\.code\.copied/.test(deco);
  },
  (src) => src.replace('chatDecorate(frag);\n  target.replaceChildren(frag);', 'target.replaceChildren(frag);\n  chatDecorate(target);'));

guarded('a tool\'s output is untrusted text: it only ever enters through textContent, and an open row stays open when its status moves',
  (src) => {
    const s = slice(src);
    const paint = fnBody(s, 'chatSkinPaintTool');
    const make = fnBody(s, 'chatSkinMakeTool');
    return /x\.out\.textContent = text/.test(paint) && !/innerHTML/.test(paint) && !/innerHTML/.test(make)
      && /aria-expanded/.test(make)
      // the status moves on the same node: classes toggle, nothing is rebuilt, so `open` survives
      && /rec\.node\.classList\.remove\('running', 'ok', 'error'\)/.test(paint) && !/rec\.node\.className\s*=/.test(paint)
      && /rec\.node\.dataset\.kind/.test(paint) && /chatSkinPaintTool\(rec, item\)/.test(fnBody(s, 'chatSkinUpsert'));
  },
  (src) => src.replace('x.out.textContent = text;', 'x.out.innerHTML = text;'));

test('tool kinds: each family gets its glyph by name, anchored, and anything else falls to the wrench', () => {
  const s = slice(app);
  const table = /const CHAT_TOOL_KINDS = \[[\s\S]*?\n\];/.exec(s)?.[0] ?? '';
  const fn = fnBody(s, 'chatToolKind');
  assert.ok(table && fn);
  const kind = new Function(`${table}\n${fn}\nreturn chatToolKind;`)() as (n: string) => { kind: string; ico: string };
  for (const [name, want] of [['Read', 'read'], ['NotebookRead', 'read'], ['Edit', 'edit'], ['Write', 'edit'], ['MultiEdit', 'edit'], ['NotebookEdit', 'edit'],
    ['Bash', 'bash'], ['BashOutput', 'bash'], ['Grep', 'search'], ['Glob', 'search'], ['LS', 'search'], ['WebFetch', 'web'], ['WebSearch', 'web'],
    ['Task', 'agent'], ['Agent', 'agent']] as Array<[string, string]>) assert.equal(kind(name).kind, want, name);
  assert.equal(kind('mcp__drive__read_file').kind, 'tool', 'an MCP tool is generic');
  assert.equal(kind('Bashful').kind, 'tool', 'control: the match is anchored, a name that merely starts like Bash is generic');
  assert.equal(kind('').kind, 'tool');
  // every glyph a kind points at exists in the icon table (a missing one would silently draw the file icon)
  const have = new Set([...app.matchAll(/^  ([A-Za-z0-9]+): '</gm)].map((m) => m[1]).concat([...s.matchAll(/^  ([A-Za-z0-9]+): '</gm)].map((m) => m[1])));
  for (const [, , ico] of [...table.matchAll(/\['(\w+)', \/[^/]+\/, '(\w+)'\]/g)].map((m) => [m[0], m[1], m[2]])) assert.ok(have.has(ico), `icon ${ico} exists`);
});

test('every animation in the skin has a prefers-reduced-motion fallback that stops it', () => {
  const sk = css.slice(css.indexOf('/* ═══ Chat skin')).replace(/\/\*[\s\S]*?\*\//g, '');
  const reduced = [...sk.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\}\s*(?=\n|$)/g)].map((m) => m[1]).join('\n');
  const animated = [...sk.matchAll(/(?:^|\n)\s*([^@{}\n][^{}\n]*?)\s*\{[^}]*\banimation:\s*(?!none)[^;}]+/g)].map((m) => m[1].trim());
  assert.ok(animated.length >= 3, `expected the skin's animated selectors, found ${animated.join(' | ')}`);
  for (const sel of animated) assert.ok(reduced.includes(sel), `${sel} animates and has no reduced-motion rule`);
  // control: a selector missing from the reduced block is caught by the same test
  assert.equal(reduced.includes('.not-in-the-skin'), false);
});

test('every string the redesigned skin shows goes through t() and exists in every locale', () => {
  // a literal key ending in a dot is a prefix (the kind or status is appended); those are expanded below
  const keys = new Set<string>([...skin.matchAll(/\bt\('(chat\.[\w.]+)'/g)].map((m) => m[1]).filter((k) => !k.endsWith('.')));
  for (const status of ['running', 'ok', 'error']) keys.add(`chat.skin.tool.${status}`);
  for (const kind of ['connecting', 'waiting', 'empty', 'error']) for (const part of ['title', 'text']) keys.add(`chat.skin.state.${kind}.${part}`);
  for (const kind of ['prompt', 'stalled']) keys.add(`chat.skin.alert.${kind}.title`);
  for (const kind of ['permission', 'trust', 'select', 'question', 'model', 'other']) keys.add(`chat.skin.prompt.${kind}`);
  for (const f of ['inherit', 'sans', 'serif', 'mono', 'inter']) keys.add(`chat.font.${f}`);
  assert.ok(keys.size > 40, `found ${keys.size} keys`);
  for (const l of Object.keys(loc)) for (const k of keys) assert.ok(typeof loc[l][k] === 'string' && loc[l][k].length > 0, `${l}.json lacks ${k}`);
  // control: a key that is not there is reported
  assert.equal(typeof loc.en['chat.skin.nothing.here'], 'undefined');
});

test('no coral in a status role: the cards and marks take their hue from --st-*, never --accent', () => {
  const sk = css.slice(css.indexOf('/* ═══ Chat skin')).replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = (sel: string): string => new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{[^}]*\\}`).exec(sk)?.[0] ?? '';
  for (const sel of ['.cs-alert', '.cs-alert.prompt', '.ct-spin', '.cw-dots i', '.chat-tool.error .ct-kind']) {
    const r = rule(sel);
    assert.ok(r, `${sel} exists`);
    assert.doesNotMatch(r, /--accent/, `${sel} must not use coral`);
  }
  assert.match(rule('.cs-alert.prompt'), /--st-input/);
  assert.match(rule('.cs-alert'), /--st-warn/);
  assert.match(rule('.ct-spin'), /--st-busy/);
  // control
  assert.match('.cs-alert { --sc: var(--accent); }', /--accent/);
});

test('the chat view names the session that is talking, never a hardcoded "Claude"', () => {
  /* The operator runs several named sessions side by side and wants to see which one answers:
     the placeholder, the working line, the attention cards and the connecting card all carry the
     pane's name. "Claude" survives only as the fallback for an unnamed pane. */
  const keys = ['chat.claude', 'chat.placeholder', 'chat.skin.working', 'chat.skin.stalled',
    'chat.skin.prompt.permission', 'chat.skin.prompt.trust', 'chat.skin.prompt.select',
    'chat.skin.prompt.question', 'chat.skin.prompt.other', 'chat.skin.state.connecting.title'];
  for (const lang of ['en', 'es', 'pt-br']) {
    const loc = JSON.parse(fs.readFileSync(`src/i18n/locales/${lang}.json`, 'utf8'));
    for (const k of keys) {
      assert.match(loc[k], /\{name\}/, `${lang} ${k} must name the session`);
      assert.doesNotMatch(loc[k], /Claude/, `${lang} ${k} still says Claude`);
    }
  }
  const src = fs.readFileSync('renderer/app.js', 'utf8');
  assert.match(src, /function chatSkinWho\(p\)/, 'one helper decides the name');
  assert.match(src, /t\('chat\.placeholder', \{ name: (chatSkinWho\(p\)|who) \}\)/, 'the composer placeholder carries the name');
  assert.match(src, /t\('chat\.skin\.prompt\.' \+ cs\.promptKind, \{ name \}\)/, 'the attention card carries the name');
});

// ── fewer colours, denser rows: coral is the send button and nothing else in the chat ─────────

/** The chat skin's rules with comments removed, as [selector, declarations] pairs (@media / @container wrappers flattened). */
function skinRules(sheet: string): Array<[string, string]> {
  const sk = sheet.slice(sheet.indexOf('/* ═══ Chat skin')).replace(/\/\*[\s\S]*?\*\//g, '');
  return [...sk.matchAll(/([^{}@;]+?)\s*\{([^{}]*)\}/g)].map((m) => [m[1].trim().replace(/\s+/g, ' '), m[2]] as [string, string]);
}
/** Selectors in the skin block whose declarations reach for the coral (--accent*, but not --chat-on-accent, the white glyph on it). */
const coralUsers = (sheet: string): string[] => skinRules(sheet)
  .filter(([, decl]) => /var\(--accent[a-z-]*\)/.test(decl.replace(/--chat-on-accent/g, '')))
  .map(([sel]) => sel);
/** The chat tokens minted in :root / body.light must not be coral either. */
const coralTokens = (sheet: string): string[] => [...sheet.matchAll(/^\s*(--chat-[a-z-]+):([^;]*);/gm)]
  .filter(([, name, value]) => name !== '--chat-on-accent' && /--accent/.test(value)).map((m) => m[1]);

test('coral is the send button and nothing else in the chat: focus, links, rings and tokens are neutral or cool', () => {
  const inView = (sheet: string): string[] => coralUsers(sheet);
  assert.deepEqual([...new Set(inView(css))].sort(), ['.cc-send', '.cc-send:hover:not(:disabled)'], 'only the send button may use the accent');
  assert.deepEqual(coralTokens(css), [], 'no chat token is built from the accent');
  // the composer card keeps a neutral focus (a border and a faint halo), and links use their own cool token
  const rule = (sel: string): string => skinRules(css).find(([s]) => s === sel)?.[1] ?? '';
  assert.match(rule('.cc-box:focus-within'), /var\(--chat-focus-line\)[\s\S]*var\(--chat-focus-soft\)/);
  assert.match(rule('.chat-md a'), /color: var\(--chat-link\)/);
  assert.match(css, /:root \{[^}]*--chat-link: var\(--st-input-ink\)/);
  // controls: a focus ring or a link painted coral again is caught by the same check
  assert.equal(inView(css.replace('.cc-box:focus-within { border-color: var(--chat-focus-line);', '.cc-box:focus-within { border-color: var(--accent);')).includes('.cc-box:focus-within'), true);
  assert.equal(inView(css.replace('.chat-md a { color: var(--chat-link);', '.chat-md a { color: var(--accent-ink);')).includes('.chat-md a'), true);
  assert.deepEqual(coralTokens(css.replace('--chat-focus-soft: color-mix(in srgb, var(--ink) 7%', '--chat-focus-soft: color-mix(in srgb, var(--accent) 7%')), ['--chat-focus-soft']);
});

test('tool rows are dense: a short row, small type for the name and the argument, still a comfortable hit target', () => {
  const head = skinRules(css).find(([s]) => s === '.ct-head')?.[1] ?? '';
  const minH = Number(/min-height:\s*(\d+)px/.exec(head)?.[1]);
  const padY = Number(/padding:\s*(\d+)px/.exec(head)?.[1]);
  assert.ok(minH >= 26 && minH <= 30, `a row is 26-30 px tall (got ${minH})`);
  assert.ok(padY <= 4, `vertical padding is at most 4 px (got ${padY})`);
  const px = (sel: string): number => Number(/font-size:\s*([\d.]+)px/.exec(skinRules(css).find(([s]) => s === sel)?.[1] ?? '')?.[1]);
  assert.ok(px('.ct-name') >= 11.5 && px('.ct-name') <= 12.5, 'the tool name is 12 px');
  assert.ok(px('.ct-arg') >= 10.5 && px('.ct-arg') <= 11.5, 'the argument is 11 px (mono) — smaller than the name, never below 10.5');
  // control: the pre-density row (36 px, 6 px padding) fails the same bounds
  assert.equal(36 >= 26 && 36 <= 30, false);
});

// ── the status bar under the composer ───────────────────────────────────────

/** chatPaintUsage, chatApplyStatus and the helpers they need, evaluated against a hand-made stand-in for the DOM: the real
 *  code, run for real, with `t` echoing its key so a test can see which sentence was chosen. */
function loadUsage(): { paint: (cs: unknown) => void; apply: (cs: unknown, s: unknown) => void; left: (sec: number, now: number) => string; when: (sec: number, now: number) => string; label: (id: string) => string; fake: () => FakeEl } {
  const s = skin;
  const from = s.indexOf('const CHAT_METERS = [');
  const to = s.indexOf('function chatSkinTip(');
  assert.ok(from > 0 && to > from, 'the usage block was found');
  const src = s.slice(from, to);
  const fake = (): FakeEl => {
    const e: FakeEl = {
      className: '', textContent: '', title: '', hidden: false, attrs: {}, props: {}, kids: [], q: {},
      classList: {
        toggle(c: string, on: boolean) { const set = new Set(e.className.split(/\s+/).filter(Boolean)); if (on) set.add(c); else set.delete(c); e.className = [...set].join(' '); },
      },
      style: { setProperty(k: string, v: string) { e.props[k] = v; } },
      setAttribute(k: string, v: string) { e.attrs[k] = v; },
      replaceChildren(...n: FakeEl[]) { e.kids = n; },
    };
    return e;
  };
  type Api = { paint: (cs: unknown) => void; apply: (cs: unknown, s: unknown) => void; left: (sec: number, now: number) => string; when: (sec: number, now: number) => string; label: (id: string) => string };
  const make = new Function('t', 'el', 'window', `${src}\nreturn { paint: chatPaintUsage, apply: chatApplyStatus, left: chatResetLeft, when: chatResetWhen, label: chatModelLabel };`) as
    (t: (k: string, v?: Record<string, unknown>) => string, el: (tag: string, cls?: string, text?: string) => FakeEl, w: unknown) => Api;
  const t = (k: string, v?: Record<string, unknown>): string => (v ? `${k}${JSON.stringify(v)}` : k);
  const el = (_tag: string, cls = '', text = ''): FakeEl => { const n = fake(); n.className = cls; n.textContent = text; return n; };
  return { ...make(t, el, { i18n: { getLocale: () => 'en' } }), fake };
}
interface FakeEl {
  className: string; textContent: string; title: string; hidden: boolean; attrs: Record<string, string>; props: Record<string, string>; kids: FakeEl[]; q: Record<string, FakeEl>;
  classList: { toggle(c: string, on: boolean): void }; style: { setProperty(k: string, v: string): void };
  setAttribute(k: string, v: string): void; replaceChildren(...n: FakeEl[]): void;
}
interface Part { seg: FakeEl; v: FakeEl; of: FakeEl; tipH: FakeEl; tipV: FakeEl; tipD: FakeEl }
/** A `cs` with the three meters, the model and the effort, shaped as chatSkinBuild makes them (`barParts`). */
function usageCs(u: ReturnType<typeof loadUsage>, status: Record<string, unknown>, extra: Record<string, unknown> = {}): { cs: Record<string, unknown>; parts: Record<string, Part> } {
  const parts: Record<string, Part> = {};
  for (const k of ['fiveHourPct', 'sevenDayPct', 'contextPct', 'model', 'effort']) parts[k] = { seg: u.fake(), v: u.fake(), of: u.fake(), tipH: u.fake(), tipV: u.fake(), tipD: u.fake() };
  return { cs: { status, barParts: parts, ...extra }, parts };
}
const tipOf = (p: Part): { h: string; v: string; d: string[] } => ({ h: p.tipH.textContent, v: p.tipV.textContent, d: p.tipD.kids.map((k) => k.textContent) });

test('status bar, run for real: a missing reading is a dash and an empty ring; a present one is the percentage, amber from 60 and red from 85', () => {
  const u = loadUsage();
  const none = usageCs(u, {});
  u.paint(none.cs);
  for (const k of ['fiveHourPct', 'sevenDayPct', 'contextPct']) {
    assert.equal(none.parts[k].v.textContent, '—', `${k}: a dash, never 0`);
    assert.equal(none.parts[k].seg.props['--p'], '0');
    assert.match(none.parts[k].seg.className, /\bnone\b/);
    assert.equal(tipOf(none.parts[k]).v, 'chat.usage.none');
    assert.deepEqual(tipOf(none.parts[k]).d, [], 'no invented detail');
  }
  const band = (pct: number): string => { const x = usageCs(u, { fiveHourPct: pct }); u.paint(x.cs); return x.parts.fiveHourPct.seg.className; };
  assert.doesNotMatch(band(42), /\b(warn|hot|none)\b/, 'neutral at 42');
  assert.doesNotMatch(band(59), /\b(warn|hot)\b/, 'neutral just under 60');
  assert.match(band(60), /\bwarn\b/, 'amber from 60');
  assert.match(band(72), /\bwarn\b/);
  assert.match(band(84), /\bwarn\b/);
  assert.doesNotMatch(band(84), /\bhot\b/);
  assert.match(band(85), /\bhot\b/, 'red from 85');
  assert.doesNotMatch(band(85), /\bwarn\b/, 'one colour at a time');
  assert.match(band(100), /\bhot\b/);
  const some = usageCs(u, { fiveHourPct: 42, sevenDayPct: 71, contextPct: 93 });
  u.paint(some.cs);
  assert.equal(some.parts.fiveHourPct.v.textContent, '42%');
  assert.equal(some.parts.fiveHourPct.seg.props['--p'], '42');
  assert.match(some.parts.fiveHourPct.seg.attrs['aria-label'], /42%/, 'the value is in the accessible name');
  assert.equal(tipOf(some.parts.sevenDayPct).v, 'chat.usage.tip.used{"pct":71}');
  // an honest zero is a zero (a real reading), unlike an absent one
  const zero = usageCs(u, { fiveHourPct: 0 });
  u.paint(zero.cs);
  assert.equal(zero.parts.fiveHourPct.v.textContent, '0%');
  assert.doesNotMatch(zero.parts.fiveHourPct.seg.className, /\bnone\b/);
  // repainting keeps the classes the painter does not own (the hover card is "tip-open")
  const open = usageCs(u, { fiveHourPct: 70 });
  open.parts.fiveHourPct.seg.className = 'cb-m tip-open';
  u.paint(open.cs);
  assert.match(open.parts.fiveHourPct.seg.className, /\btip-open\b/);
});

test('status bar, run for real: resets appear only when the payload carried them, and a reset already behind us marks the reading stale', () => {
  const u = loadUsage();
  const now = Date.now();
  const sec = (ms: number): number => Math.floor((now + ms) / 1000);
  const without = usageCs(u, { fiveHourPct: 42, sevenDayPct: 10 });
  u.paint(without.cs);
  assert.deepEqual(tipOf(without.parts.fiveHourPct).d, [], 'no reset in the payload → no reset line (nothing is derived from "5 hours")');
  assert.deepEqual(tipOf(without.parts.sevenDayPct).d, []);
  const withR = usageCs(u, { fiveHourPct: 42, sevenDayPct: 10, fiveHourResetsAt: sec(2 * 3600e3 + 10 * 60e3), sevenDayResetsAt: sec(50 * 3600e3) });
  u.paint(withR.cs);
  assert.match(tipOf(withR.parts.fiveHourPct).d[0], /^chat\.usage\.tip\.resets\{/);
  assert.match(tipOf(withR.parts.fiveHourPct).d[0], /"left":"chat\.usage\.unit\.h\{\\"n\\":2\}[^"]*chat\.usage\.unit\.m\{\\"n\\":(9|10)\}"/, 'in 2 h 10 min');
  assert.match(tipOf(withR.parts.sevenDayPct).d[0], /"left":"chat\.usage\.unit\.d\{\\"n\\":2\} chat\.usage\.unit\.h\{\\"n\\":2\}"/, 'in 2 d 2 h (no minutes once days are shown)');
  const stale = usageCs(u, { fiveHourPct: 90, fiveHourResetsAt: sec(-60e3) });
  u.paint(stale.cs);
  assert.deepEqual(tipOf(stale.parts.fiveHourPct).d, ['chat.usage.tip.stale']);
  assert.match(stale.parts.fiveHourPct.seg.className, /\bstale\b/);
  assert.doesNotMatch(withR.parts.fiveHourPct.seg.className, /\bstale\b/);
  // control: a reset line for a meter that has no reset field (context) never appears
  assert.deepEqual(tipOf(withR.parts.contextPct).d, []);
});

test('status bar, run for real: the context is this pane\'s own tokens over the window — used / limit with a bar — and says so only when they agree', () => {
  const u = loadUsage();
  const ok = usageCs(u, { contextPct: 5, contextWindow: 200000 }, { ctxTokens: 84000 });
  u.paint(ok.cs);
  assert.equal(ok.parts.contextPct.v.textContent, '84k');
  assert.equal(ok.parts.contextPct.of.textContent, '/ 200k', 'used / limit');
  assert.equal(ok.parts.contextPct.seg.props['--p'], '42', 'own tokens / window, not the global payload\'s percentage');
  assert.match(tipOf(ok.parts.contextPct).d[0], /^chat\.usage\.tip\.ctxOf\{"used":"84,000","total":"200,000"\}$/);
  assert.match(ok.parts.contextPct.seg.attrs['aria-label'], /84k \/ 200k \(42%\)/);
  // tokens above the payload's window: the payload describes another session's model — tokens only, no percentage, no limit
  const clash = usageCs(u, { contextPct: 5, contextWindow: 200000 }, { ctxTokens: 300000 });
  u.paint(clash.cs);
  assert.equal(clash.parts.contextPct.v.textContent, '300k');
  assert.equal(clash.parts.contextPct.of.textContent, '');
  assert.equal(clash.parts.contextPct.seg.props['--p'], '0');
  assert.match(tipOf(clash.parts.contextPct).d[0], /^chat\.usage\.tip\.ctxUsed\{/);
  // no window size known: the payload's own percentage still drives the bar, the tokens are what is shown, and there is no limit to show
  const nowin = usageCs(u, { contextPct: 31 }, { ctxTokens: 62000 });
  u.paint(nowin.cs);
  assert.equal(nowin.parts.contextPct.v.textContent, '62k');
  assert.equal(nowin.parts.contextPct.of.textContent, '');
  assert.equal(nowin.parts.contextPct.seg.props['--p'], '31');
  // no tokens at all, only a percentage that is this tab's: the percentage; nothing: a dash
  const pctOnly = usageCs(u, { contextPct: 38 });
  u.paint(pctOnly.cs);
  assert.equal(pctOnly.parts.contextPct.v.textContent, '38%');
  // colour follows the percentage of the WINDOW, not the token count: 182k of 200k is red
  const hot = usageCs(u, { contextWindow: 200000 }, { ctxTokens: 182000 });
  u.paint(hot.cs);
  assert.match(hot.parts.contextPct.seg.className, /\bhot\b/);
});

test('status bar, run for real: the payload is global, so model, effort, context and window are only taken when it is THIS tab\'s (sessionMatch === true)', () => {
  const u = loadUsage();
  const payload = { fiveHourPct: 42, sevenDayPct: 55, fiveHourResetsAt: 2e9, sevenDayResetsAt: 2e9, model: 'claude-opus-5-5', effort: 'max', contextPct: 97, contextWindow: 1000000 };
  const foreign = usageCs(u, {});
  u.apply(foreign.cs, { ...payload, sessionMatch: false });
  assert.deepEqual(foreign.cs.status, { fiveHourPct: 42, sevenDayPct: 55, fiveHourResetsAt: 2e9, sevenDayResetsAt: 2e9 }, 'only the account-wide windows and their resets');
  // the effort is a button now, so it stays (the operator can choose it without knowing the current one) — but with a faint WORD, never a dash and never the other session's value
  assert.equal(foreign.parts.effort.seg.hidden, false, 'the effort button is always there');
  assert.equal(foreign.parts.effort.v.textContent, 'chat.bar.effortWord', 'no effort has ever been reported by this tab\'s own payload: a word, not a dash and not the foreign value');
  assert.match(foreign.parts.effort.v.className, /\bnone\b/);
  assert.equal(foreign.parts.effort.seg.title, 'chat.bar.effortPick');
  assert.doesNotMatch(JSON.stringify(foreign.parts.effort), /max/, 'the foreign payload\'s effort is nowhere on the segment');
  // anything but a literal true is a no: a missing flag (an older main) and truthy look-alikes
  for (const flag of [undefined, null, 'true', 1, {}]) {
    const x = usageCs(u, {});
    u.apply(x.cs, { ...payload, sessionMatch: flag });
    assert.equal((x.cs.status as Record<string, unknown>).effort, undefined, `sessionMatch ${JSON.stringify(flag)} must not write the effort`);
    assert.equal((x.cs.status as Record<string, unknown>).model, undefined);
  }
  const mine = usageCs(u, {});
  u.apply(mine.cs, { ...payload, sessionMatch: true });
  assert.equal((mine.cs.status as Record<string, unknown>).effort, 'max');
  assert.equal((mine.cs.status as Record<string, unknown>).contextWindow, 1000000);
  assert.equal(mine.parts.effort.seg.hidden, false);
  assert.equal(mine.parts.effort.v.textContent, 'chat.bar.effort.max');
  assert.doesNotMatch(mine.parts.effort.v.className, /\bnone\b/);
  assert.equal(mine.parts.effort.seg.title, 'chat.bar.effortTip{"level":"chat.bar.effort.max"}');
  assert.equal(mine.parts.effort.seg.attrs['aria-label'], 'chat.bar.effortAria{"level":"chat.bar.effort.max"}');
  // an effort this build does not know is shown as it came, never swallowed
  const odd = usageCs(u, {});
  u.apply(odd.cs, { effort: 'ultra', sessionMatch: true });
  assert.equal(odd.parts.effort.v.textContent, 'ultra');
  // a later payload that is not this tab's changes nothing it already knew
  u.apply(mine.cs, { effort: 'low', model: 'claude-haiku-4-5', sessionMatch: false });
  assert.equal((mine.cs.status as Record<string, unknown>).effort, 'max');
  // the model: this tab's own transcript wins, then a matching payload, and never a foreign one
  const tr = usageCs(u, {}, { model: 'claude-sonnet-5-5' });
  u.apply(tr.cs, { model: 'claude-opus-5-5', sessionMatch: false });
  assert.equal(tr.parts.model.v.textContent, 'Sonnet 5.5');
  const fromPayload = usageCs(u, {});
  u.apply(fromPayload.cs, { model: 'claude-opus-5-5', sessionMatch: true });
  assert.equal(fromPayload.parts.model.v.textContent, 'Opus 5.5');
  const nobody = usageCs(u, {});
  u.paint(nobody.cs);
  assert.equal(nobody.parts.model.v.textContent, '—');
});

test('status bar: model names read as a person says them, and an id nobody taught us is shown as it came', () => {
  const u = loadUsage();
  assert.equal(u.label('claude-sonnet-5-5'), 'Sonnet 5.5');
  assert.equal(u.label('claude-opus-5'), 'Opus 5');
  assert.equal(u.label('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(u.label('claude-opus-4-1[1m]'), 'Opus 4.1');
  assert.equal(u.label('claude-3-5-sonnet-20241022'), 'Sonnet 3.5');
  assert.equal(u.label('some-other-model'), 'some-other-model');
});

test('status bar: the reset formatters give the two largest units, and a clock time today or weekday + time otherwise', () => {
  const u = loadUsage();
  const now = new Date(2026, 9, 26, 12, 0, 0).getTime();
  const at = (ms: number): number => Math.floor((now + ms) / 1000);
  assert.equal(u.left(at(14 * 60e3), now), 'chat.usage.unit.m{"n":14}');
  assert.equal(u.left(at(60 * 60e3), now), 'chat.usage.unit.h{"n":1}', 'a whole hour has no "0 min"');
  assert.equal(u.left(at(26 * 3600e3), now), 'chat.usage.unit.d{"n":1} chat.usage.unit.h{"n":2}');
  assert.equal(u.left(at(-5000), now), 'chat.usage.unit.m{"n":0}', 'never negative');
  assert.match(u.when(at(3 * 3600e3), now), /^\d{1,2}:\d{2}/, 'later today: just the time');
  assert.match(u.when(at(30 * 3600e3), now), /^[A-Za-z]{3}\.? \d{1,2}:\d{2}/, 'another day: weekday and time');
});

test('status bar: the thresholds are 60 and 85, named once, and the painter reads those names (no stray 70 or 90)', () => {
  assert.match(skin, /const CHAT_WARN_PCT = 60, CHAT_HOT_PCT = 85;/);
  const paint = fnBody(skin, 'chatPaintUsage');
  assert.match(paint, /pct >= CHAT_WARN_PCT && pct < CHAT_HOT_PCT/);
  assert.match(paint, /pct >= CHAT_HOT_PCT/);
  assert.doesNotMatch(paint, /\b(70|90)\b/);
  assert.match(paint, /const has = typeof pct === 'number' && Number\.isFinite\(pct\)/);
  assert.match(paint, /setProperty\('--p', has \? /, 'the ring and the bar are empty without a reading');
  assert.match(paint, /\.\.\.lines\]\.join\(' — '\)/, 'the accessible name carries the value and the detail');
});

guarded('the status payload is asked for with THIS tab\'s session id, and per-session fields are written only when main says it matches',
  (src) => {
    const s = slice(src);
    const apply = fnBody(s, 'chatApplyStatus');
    const refresh = fnBody(s, 'chatSkinRefreshStatus');
    return /gs\.chatStatus\(cs\.pane\.sessionId\)/.test(refresh)
      && /const CHAT_STATUS_OWN = \['contextPct', 'model', 'effort', 'contextWindow'\];/.test(s)
      && /CHAT_STATUS_OWN\.includes\(k\) && s\.sessionMatch !== true\) continue;/.test(apply)
      && /s\[k\] === undefined \|\| s\[k\] === null \|\| s\[k\] === ''\) continue;/.test(apply);
  },
  (src) => src.replace('if (CHAT_STATUS_OWN.includes(k) && s.sessionMatch !== true) continue;', ''));

guarded('the status bar is built UNDER the card, and the card holds only the text and send/stop (no chips, no usage row)',
  (src) => {
    const b = fnBody(slice(src), 'chatSkinBuild');
    return /meta\.appendChild\(bar\)/.test(b) && /compose\.append\(jumpBtn, wrap, meta\)/.test(b)
      && /root\.append\(log, alertEl, compose\)/.test(b)   // log, notice, compose block: nothing above the log
      && /box\.append\(input, ccRow, dropEl\)/.test(b) && /ccRow\.append\(stopBtn, sendBtn\)/.test(b)
      && !/cc-chip|chat-usage|usageEl|usageVals/.test(slice(src))
      && b.indexOf('wrap.append(slashPop, box)') > 0 && b.indexOf('wrap.append(slashPop, box)') < b.indexOf('compose.append(')
      && !/cc-chip|chat-usage/.test(css);
  },
  // the bar moved out of the compose block (into the pane itself): the card and the strip are no longer one object
  (src) => src.replace('meta.appendChild(bar);', 'root.append(bar);'));

// ── the pane has no header ──────────────────────────────────────────────────

/** Everything the old header was made of, as it could be named in the source or the stylesheet. */
const HEADER_TRACES = /cs-head|cs-switch|cs-sw\b|cs-gear|cs-menu|cs-fill|csm-|swTerm|swChat|chatSkinMenu|chatSkinOpt\b|chatSkinCheck|menuOpen|\bfontList\b|\bsizeList\b|textSize/;
guarded('the pane has no header: no Terminal | Chat switch, no Aa button, no font menu — the log is the first thing in the overlay',
  (src) => {
    const s = slice(src);
    const b = fnBody(s, 'chatSkinBuild');
    return !HEADER_TRACES.test(s) && /root\.append\(log, alertEl, compose\)/.test(b) && !/\bhead\b/.test(b.replace(/\/\*[\s\S]*?\*\//g, ''))
      // the reading settings are not set from the conversation any more: only applied there
      && !/setSetting\('chatFont/.test(s) && /function chatApplyPrefs\(\)/.test(s) && /function chatReadPrefs\(c\)/.test(s);
  },
  (src) => src.replace('root.append(log, alertEl, compose);', "const head = el('div', 'cs-head');\n  root.append(head, log, alertEl, compose);"));

test('the stylesheet carries no rule of the old header, and the stylesheet check catches one that comes back', () => {
  assert.doesNotMatch(css, HEADER_TRACES);
  assert.match(css + '\n.cs-head { padding: 9px 14px; }', HEADER_TRACES, 'control: a header rule would be caught');
  assert.match(css + '\n.cs-gear { width: 30px; }', HEADER_TRACES, 'control: so would the Aa button');
  // no place left for the strip: the first child of the overlay is the log, which fills it
  assert.match(skinRules(css).find(([sel]) => sel === '.chat-log')?.[1] ?? '', /flex: 1/);
});

guarded('every meter answers hover AND keyboard focus with its detail card, aria-labelled, and the card is not read twice',
  (src) => {
    const b = fnBody(slice(src), 'chatSkinBuild');
    const tip = fnBody(slice(src), 'chatSkinTip');
    return /seg\.tabIndex = 0/.test(b) && /seg\.addEventListener\('pointerenter', \(\) => chatSkinTip\(seg, true\)\)/.test(b)
      && /seg\.addEventListener\('focus', \(\) => chatSkinTip\(seg, true\)\)/.test(b) && /seg\.addEventListener\('blur', \(\) => chatSkinTip\(seg, false\)\)/.test(b)
      && /tip\.setAttribute\('aria-hidden', 'true'\)/.test(b) && /seg\.setAttribute\('role', 'img'\)/.test(b)
      && /classList\.toggle\('tip-open', on\)/.test(tip)
      && /bar\.setAttribute\('aria-label', t\('chat\.bar\.label', \{ name: chatSkinWho\(p\) \}\)\)/.test(b)   // the session's name, from the one function that knows it
      && !/seg\.title\s*=/.test(fnBody(slice(src), 'chatPaintUsage').split('/* Model:')[0]);   // no native title on a meter: the card is ours
  },
  (src) => src.replace("seg.addEventListener('focus', () => chatSkinTip(seg, true));", ''));

guarded('the model in the bar sends /model through the same chokepoint as a typed message — and never while a turn runs or a dialog is open',
  (src) => {
    const s = slice(src);
    const menu = fnBody(s, 'chatSkinModelMenu');
    const submit = fnBody(s, 'chatSkinSubmit');
    const blocked = fnBody(s, 'chatSkinBarBlocked');
    return /chatSkinSubmit\(id, p, '\/model'\)/.test(menu) && /chatSkinBarBlocked\(p\)/.test(menu) && !/ptyWrite|ptyRun/.test(menu)
      && /p\.exited/.test(blocked) && /cs\.promptKind/.test(blocked) && /chatSkinWorking\(p\)/.test(blocked)
      && /submitToPty\(id, text\)/.test(submit) && /chatSkinSubmit\(id, p, text\)/.test(fnBody(s, 'chatSkinSendNow'))
      && /modelSeg\.addEventListener\('click', \(\) => chatSkinModelMenu\(id, p\)\)/.test(fnBody(s, 'chatSkinBuild'))
      && /const blocked = chatSkinBarBlocked\(p\);[\s\S]*cs\.modelSeg\.disabled = blocked/.test(fnBody(s, 'chatSkinControls'));
  },
  (src) => src.replace("chatSkinSubmit(id, p, '/model');", "window.glassShell.ptyWrite(id, '/model\\r');"));

test('the bar has ONE look, the strip: no switch, no stored preference, no other variant left behind', () => {
  // The operator compared three looks and chose the strip; the other two and everything that switched between them are gone.
  // A check on the CSS and the source together: a stray selector or a leftover switch would revive a look nobody can reach.
  const gone = (src: string): string[] => [
    ...(/CHAT_BAR_STYLES|CHAT_BAR_DEFAULT|chatStatusBarStyle|chatSkinSetBarStyle|chatSkinApplyBarStyle/.exec(src) ?? []),
    ...(/\bbar-(minimal|pills|strip)\b/.exec(src) ?? []),
    ...(/csRing|\bcu-ring\b|\.r-track\b|\.r-val\b|'r-track'|'r-val'/.exec(src) ?? []),
  ];
  assert.deepEqual(gone(app), [], 'no switch, no look class and no ring in the renderer script');
  assert.deepEqual(gone(css), [], 'no look class and no ring in the stylesheet');
  assert.doesNotMatch(read('src/test/fixtures/chat-shot.json'), /BarStyle|barShot\(ctx, '/, 'the shot fixture does not switch looks');
  // the strip is the bar's own rules, not a class someone has to remember to set
  const rules = skinRules(css);
  const rule = (sel: string): string => rules.find(([x]) => x === sel)?.[1] ?? '';
  assert.match(rule('.chat-bar'), /border-radius: 0 0 22px 22px/, 'the bar is the strip, always');
  assert.match(rule('.chat-bar'), /clip-path: inset\(0 -48px -48px -48px\)/);
  assert.match(rule('.cc-meta'), /margin-top: 0/, 'flush under the card');
  assert.match(rule('.cc-box'), /border-radius: 22px 22px 0 0/, 'the card gives its bottom corners to the strip');
  assert.match(rule('.cb-m:hover'), /background-color:/, 'a segment hover keeps its divider (the colour alone, never the shorthand)');
  assert.match(rule('.cb-meter'), /display: block/, 'the bar is always shown: it is the meter');
  // no markup left over from another look: the meter is a bar and nothing else
  assert.doesNotMatch(fnBody(skin, 'chatSkinBuild'), /createElementNS|csRing/);
  // negative control: a leftover of any removed look trips the same check
  assert.ok(gone(app + '\nconst CHAT_BAR_STYLES = [];').length > 0);
  assert.ok(gone(css + '\n.bar-pills .cb-m { }').length > 0);
  assert.ok(gone(css + '\n.cu-ring { }').length > 0);
});

test('the bar\'s CSS: thresholds through --chat-* tokens, the detail card on the bar\'s own line, hint only with focus, hidden under a dialog strip', () => {
  const rules = skinRules(css);
  const rule = (sel: string): string => rules.find(([s]) => s === sel)?.[1] ?? '';
  assert.match(rule('.cb-m.warn .cb-meter i'), /var\(--chat-meter-warn\)/);
  assert.match(rule('.cb-m.hot .cb-meter i'), /var\(--chat-meter-hot\)/);
  assert.match(rule('.cb-meter i'), /width: calc\(var\(--p, 0\) \* 1%\)/);
  assert.match(rule('.cb-m.warn .cb-v'), /var\(--chat-warn-ink\)/);
  assert.match(rule('.cb-m.hot .cb-v'), /var\(--chat-hot-ink\)/);
  // the amber and the red are the house's status hues, and never the coral
  const dark = css.slice(0, css.indexOf('body.light {'));
  assert.match(dark, /--chat-meter-warn: var\(--st-warn\);/);
  assert.match(dark, /--chat-meter-hot: var\(--st-error\);/);
  assert.deepEqual(coralTokens(css), []);
  // the detail card lies over the bar's own line: it is positioned against the bar, fills it, and nothing in its rule lifts it above
  const tip = rule('.cb-tip');
  assert.match(tip, /position: absolute/);
  assert.match(tip, /inset: 0/);
  assert.doesNotMatch(tip, /\bbottom:|\btop:\s*-|calc\(100%/, 'a card that opened upward would cover the text being typed');
  assert.match(rule('.chat-bar'), /position: relative/, 'the bar is what the card is placed against');
  assert.match(rule('.cb-m'), /flex: 0 0 auto/);
  assert.doesNotMatch(rule('.cb-m'), /position:/, 'a meter is not the containing block of its card (the bar is)');
  assert.match(rule('.cb-m.tip-open .cb-tip'), /opacity: 1/);
  const strip = rules.find(([s]) => s.startsWith('.pane.cs-strip > .chatskin .chat-bar'));
  assert.ok(strip && /\.cc-meta/.test(strip[0]) && /\.chat-compose/.test(strip[0]) && /display: none/.test(strip[1]), 'the strip rule hides the bar (and the whole compose block) for a live dialog');
  assert.match(rule('.cb-hint'), /opacity: 0/, 'the keys hint is invisible until the box has focus');
  assert.match(rule('.cc-wrap:focus-within + .cc-meta .cb-hint'), /opacity: 1/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.cb-m, \.cb-meter i, \.cb-tip, \.cb-hint, \.chat-bar \{ transition: none; \}/);
  // control: the old floating card (up and away from its meter) would trip the same check
  assert.match(rule('.cb-tip').replace('inset: 0;', 'bottom: calc(100% + 8px);'), /calc\(100%/);
});

test('a narrow pane gives up the labels first, then the "of 200k", then the effort, and only then the numbers — the bars never', () => {
  const widths = (sel: RegExp): number[] => [...css.matchAll(/@container \(max-width: (\d+)px\) \{([^@\n]*)\}/g)].filter((m) => sel.test(m[2])).map((m) => Number(m[1]));
  const labels = Math.max(...widths(/\.cb-k \{ display: none/));
  const of = Math.max(...widths(/\.cb-of \{ display: none/));
  const effort = Math.max(...widths(/\.cb-effort \{ display: none/));
  const values = Math.max(...widths(/\.cb-m \.cb-v \{ display: none/));
  assert.ok(labels > 0 && of > 0 && effort > 0 && values > 0, `all the steps exist (${[labels, of, effort, values]})`);
  assert.ok(labels > of && of >= effort - 20 && effort > values, `order of loss by width: labels ${labels} > of ${of} > effort ${effort} > numbers ${values}`);
  // nothing ever hides the bar itself
  assert.doesNotMatch(css, /@container[^{]*\{[^}]*\.cb-meter(?! i)[^}]*display: none/);
  // the bar is its own size container, so the steps follow the bar and not the window
  assert.match(skinRules(css).find(([s]) => s === '.cc-meta')?.[1] ?? '', /container-type: inline-size/);
});

test('the status bar\'s sentences exist in every locale (the ones built at run time included), with the same placeholders', () => {
  const keys = ['chat.hintShort', 'chat.bar.hintTiny', 'chat.bar.label', 'chat.bar.modelTip', 'chat.bar.modelPick', 'chat.bar.modelAria', 'chat.usage.tip.fiveHour', 'chat.usage.tip.sevenDay', 'chat.usage.tip.context',
    'chat.usage.tip.used', 'chat.usage.tip.resets', 'chat.usage.tip.stale', 'chat.usage.tip.ctxOf', 'chat.usage.tip.ctxUsed', 'chat.usage.unit.d', 'chat.usage.unit.h', 'chat.usage.unit.m', 'chat.usage.none',
    'chat.usage.fiveHour', 'chat.usage.sevenDay', 'chat.usage.context', 'chat.usage.effort'];
  const efforts = /const CHAT_EFFORTS = \[([^\]]+)\]/.exec(skin)?.[1].match(/'(\w+)'/g)?.map((x) => x.slice(1, -1)) ?? [];
  assert.deepEqual(efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
  for (const e of efforts) keys.push('chat.bar.effort.' + e);
  for (const k of keys) for (const l of Object.keys(loc)) assert.ok(typeof loc[l][k] === 'string' && loc[l][k].length > 0, `${l}.json lacks ${k}`);
  const holes = (s: string): string => (s.match(/\{[a-zA-Z]+\}/g) || []).sort().join(',');
  for (const k of keys) for (const l of ['es', 'pt-br']) assert.equal(holes(loc[l][k]), holes(loc.en[k]), `${l} ${k}`);
  assert.equal(holes(loc.en['chat.usage.tip.resets']), '{left},{when}');
  assert.equal(holes(loc.en['chat.bar.label']), '{name}', 'the bar is named after the session, like every other sentence about it');
  assert.equal(holes(loc.en['chat.bar.modelAria']), '{model}');
  // every key the painter builds at run time is in the list above
  assert.deepEqual([...skin.matchAll(/\['(?:fiveHourPct|sevenDayPct|contextPct)', 'chat\.usage\.\w+', '(chat\.usage\.tip\.\w+)'\]/g)].map((m) => m[1]), ['chat.usage.tip.fiveHour', 'chat.usage.tip.sevenDay', 'chat.usage.tip.context']);
  assert.match(skin, /t\('chat\.bar\.effort\.' \+ effort\)/);
  // the old row is gone with its sentence
  assert.equal(typeof loc.en['chat.usage.contextTokens'], 'undefined');
});

test('chat-shot fixture: the strip × light/dark × wide/narrow/card open/hot values, plus a payload that is not this tab\'s', () => {
  const byName = (n: string): FxShot | undefined => fixture.shots.find((s) => s.name === n);
  const js = (n: string): string => String([byName(n)?.js].flat().join('\n'));
  for (const th of ['light', 'dark']) {
    for (const suffix of ['', '-narrow', '-tip', '-hot', '-hot-tip']) {
      const n = `bar-strip-${th}${suffix}`;
      assert.ok(byName(n), `missing shot ${n}`);
      assert.equal(byName(n)?.theme, th);
      assert.match(js(n), /barShot\(ctx[,)]/, `${n} goes through the shared helper, which takes no look`);
    }
    for (const suffix of ['-tip', '-hot-tip']) assert.match(js(`bar-strip-${th}${suffix}`), /tip: '(fiveHourPct|contextPct)'/, 'the card is forced open');
    assert.match(js(`bar-strip-${th}-narrow`), /pane: \d+/, 'a narrow pane (the window width alone would only shrink the layout around it)');
    assert.deepEqual(byName(`bar-strip-${th}-hot`)?.events, ['conversation', 'bar-hot']);
  }
  // only the strip is shot: a look that does not exist has no pictures
  assert.deepEqual(fixture.shots.map((x) => x.name).filter((n) => /^bar-(minimal|pills)-/.test(n)), []);
  // the helper fails the run when the card reaches into the composer or leaves the bar
  const setup = [fixture.setup].flat().join('\n');
  assert.match(setup, /tip\.top < box\.bottom/);
  assert.match(setup, /tip\.top < bar\.top[\s\S]*tip\.right > bar\.right/);
  assert.doesNotMatch(setup, /BarStyle/, 'the helper has no look to pick');
  // hot values: amber on the 5 h, red on the context (tokens of the window)
  const hot = fixture.streams['bar-hot'];
  const st = hot.find((e) => e.type === 'status') as FxEvent;
  const us = hot.find((e) => e.type === 'usage') as FxEvent;
  assert.ok(Number(st.fiveHourPct) >= 60 && Number(st.fiveHourPct) < 85, 'amber');
  assert.ok(Number(us.contextTokens) / Number(st.contextWindow) >= 0.85, 'red');
  // every status event that carries a per-session field says whether it is this tab's
  for (const [name, evs] of Object.entries(fixture.streams)) for (const e of evs) {
    if (e.type === 'status' && ['model', 'effort', 'contextPct', 'contextWindow'].some((k) => k in e)) assert.equal(typeof e.sessionMatch, 'boolean', `${name}: a status event with per-session fields declares sessionMatch`);
  }
  assert.equal((fixture.streams.conversation.find((e) => e.type === 'status') as FxEvent).sessionMatch, true);
  // the payload that is not this tab's: the shot feeds one and FAILS if the effort shows that session's level or the model is not the transcript's
  const nm = js('bar-nomatch-dark');
  assert.match(nm, /"sessionMatch": false/);
  assert.match(nm, /barParts\.effort\.v\.textContent !== t\('chat\.bar\.effortWord'\)\) throw/);
  assert.match(nm, /'Sonnet 5\.5'/);
  // resets in the fixture are relative ("+seconds"), never an instant that would be in the past by the next run
  const resets = [...Object.values(fixture.streams).flat(), ...fixture.shots.flatMap((s) => [s.js].flat().join('\n').match(/"[a-zA-Z]+ResetsAt": ("[^"]*"|\d+)/g) ?? [])]
    .flatMap((e) => (typeof e === 'string' ? [e.split(': ')[1].replace(/"/g, '')] : Object.entries(e).filter(([k]) => /ResetsAt$/.test(k)).map(([, v]) => v)));
  assert.ok(resets.length >= 4 && resets.every((v) => typeof v === 'string' && /^\+\d+$/.test(v)), `relative resets only (${resets.join(', ')})`);
  assert.match(main, /\/ResetsAt\$\/\.test\(k\) && typeof s\[k\] === 'string' && \/\^\\\+\\d\+\$\/\.test\(s\[k\]\)/, 'the driver understands them');
  // and the dense tool rows are still shot
  for (const n of ['tools-dense-dark', 'tools-dense-light']) assert.ok(byName(n), `missing shot ${n}`);
});

// ── the slash-command popup ─────────────────────────────────────────────────

/** A stand-in element rich enough for the popup code: attributes, classes, children, listeners. */
class FakeNode {
  tag: string; className = ''; textContent = ''; id = ''; hidden = false; value = ''; scrollTop = 0;
  attrs: Record<string, string> = {}; children: FakeNode[] = []; handlers: Record<string, Array<(e: unknown) => void>> = {};
  selection: [number, number] | null = null;
  get selectionStart(): number { return this.selection ? this.selection[0] : this.value.length; }
  get selectionEnd(): number { return this.selection ? this.selection[1] : this.value.length; }
  constructor(tag: string, cls = '', text = '') { this.tag = tag; this.className = cls; this.textContent = text; }
  classList = {
    toggle: (c: string, on: boolean): void => { const s = new Set(this.className.split(/\s+/).filter(Boolean)); if (on) s.add(c); else s.delete(c); this.className = [...s].join(' '); },
  };
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  removeAttribute(k: string): void { delete this.attrs[k]; }
  appendChild(n: FakeNode): FakeNode { this.children.push(n); return n; }
  replaceChildren(...n: FakeNode[]): void { this.children = n; }
  addEventListener(ev: string, fn: (e: unknown) => void): void { (this.handlers[ev] ||= []).push(fn); }
  scrollIntoView(): void { /* layout is not under test */ }
  setSelectionRange(a: number, b: number): void { this.selection = [a, b]; }
  focus(): void { /* focus is not under test */ }
}
interface SlashHarness {
  cs: { slash: { open: boolean; items: unknown[]; index: number; seq: number; pop: FakeNode; list: FakeNode }; input: FakeNode; pane: unknown };
  fns: { refresh: (cs: unknown, p: unknown) => void; show: (cs: unknown, rows: unknown[]) => void; move: (cs: unknown, to: number, scroll?: boolean) => void; close: (cs: unknown) => void; pick: (cs: unknown, i: number) => void; key: (cs: unknown, e: Record<string, unknown>) => boolean };
  calls: string[]; asked: Array<[unknown, string]>; answer: (rows: unknown[]) => Promise<void>;
}
/** The popup's functions, from the real source, wired to fakes. `answer` resolves the pending slashCommands() call. */
function slashHarness(src: string = skin): SlashHarness {
  const from = src.indexOf('function chatSkinSlashRefresh(');
  const to = src.indexOf('/* Which glyph a tool wears');
  assert.ok(from > 0 && to > from, 'the popup block was found');
  const calls: string[] = [];
  const asked: Array<[unknown, string]> = [];
  let resolve: (rows: unknown[]) => void = () => undefined;
  const glassShell = { slashCommands: (cwd: unknown, text: string): Promise<unknown[]> => { asked.push([cwd, text]); return new Promise((r) => { resolve = r; }); }, ptyWrite: (): void => { calls.push('ptyWrite'); } };
  const input = new FakeNode('textarea');
  const cs = { slash: { open: false, items: [] as unknown[], index: 0, seq: 0, pop: new FakeNode('div'), list: new FakeNode('div') }, input, pane: { view: 'chat' }, promptKind: null };
  cs.slash.pop.hidden = true;
  cs.slash.list.id = 'cs-slash-7';
  const make = new Function('window', 'el', 't', 'chatSkinAutosize', 'chatSkinControls',
    `${src.slice(from, to)}\nreturn { refresh: chatSkinSlashRefresh, show: chatSkinSlashShow, move: chatSkinSlashMove, close: chatSkinSlashClose, pick: chatSkinSlashPick, key: chatSkinSlashKey };`) as
    (w: unknown, el: (tag: string, cls?: string, text?: string) => FakeNode, t: (k: string) => string, auto: () => void, controls: () => void) => SlashHarness['fns'];
  const fns = make({ glassShell }, (tag, cls, text) => new FakeNode(tag, cls, text), (k) => `«${k}»`, () => calls.push('autosize'), () => calls.push('controls'));
  return { cs, fns, calls, asked, answer: async (rows) => { resolve(rows); await new Promise((r) => setTimeout(r, 0)); } };
}
const ROWS = [
  { name: 'compact', description: '', descKey: 'chat.slash.cmd.compact', argumentHint: '<optional custom summarization instructions>', source: 'builtin' },
  { name: 'deploy', description: 'Push to staging', argumentHint: '[branch]', source: 'project' },
  { name: 'aios:today', description: 'Daily plan', source: 'plugin', plugin: 'aios' },
];
const keyEv = (key: string, o: Record<string, unknown> = {}): Record<string, unknown> & { prevented: boolean } => {
  const e = { key, keyCode: key === 'Enter' ? 13 : 0, shiftKey: false, isComposing: false, altKey: false, metaKey: false, ctrlKey: false, prevented: false, preventDefault() { e.prevented = true; }, ...o };
  return e;
};

test('slash popup, run for real: "/" asks main with the pane\'s folder, shows the rows as an accessible listbox, and a stale answer is ignored', async () => {
  const h = slashHarness();
  h.cs.input.value = '/';
  (h.cs.pane as { cwd?: string }).cwd = '/work/app';
  h.fns.refresh(h.cs, h.cs.pane);
  assert.deepEqual(h.asked, [['/work/app', '/']], 'main is asked with the pane\'s folder and the text');
  await h.answer(ROWS);
  const s = h.cs.slash;
  assert.equal(s.open, true);
  assert.equal(s.pop.hidden, false);
  assert.equal(s.list.children.length, 3);
  const rows = s.list.children;
  assert.ok(rows.every((r) => r.attrs.role === 'option' && /^cs-slash-7-\d$/.test(r.id)), 'options with ids the box can point at');
  assert.deepEqual(rows.map((r) => r.attrs['aria-selected']), ['true', 'false', 'false']);
  assert.equal(h.cs.input.attrs['aria-activedescendant'], rows[0].id);
  assert.equal(h.cs.input.attrs['aria-expanded'], 'true');
  // built-ins are described through t(); a file's description is shown as written; a project command carries its tag, a plugin's name is already the prefix
  assert.deepEqual(rows[0].children.map((c) => c.textContent), ['/compact', '<optional custom…>', '«chat.slash.cmd.compact»'], 'a long usage is shortened at a word, brackets closed');
  assert.equal((rows[0].children[1] as unknown as { title?: string }).title, '<optional custom summarization instructions>', 'and the whole usage stays one hover away');
  assert.equal((rows[1].children[1] as unknown as { title?: string }).title, undefined, 'a usage that fits has no title');
  assert.deepEqual(rows[1].children.map((c) => c.textContent), ['/deploy', '[branch]', 'Push to staging', '«chat.slash.src.project»']);
  assert.deepEqual(rows[2].children.map((c) => c.textContent), ['/aios:today', '', 'Daily plan'], 'an empty usage cell keeps the columns aligned');
  // a text that no longer starts with a slash closes it, and an answer that arrives late does not bring it back
  h.cs.input.value = '/c';
  h.fns.refresh(h.cs, h.cs.pane);
  h.cs.input.value = 'hello';
  h.fns.refresh(h.cs, h.cs.pane);
  assert.equal(s.open, false);
  await h.answer(ROWS);
  assert.equal(s.open, false, 'the late answer for "/c" is dropped');
  assert.equal(h.asked.length, 2, 'prose never asks main at all');
  // an empty answer (no match, or a finished command) means no popup
  h.cs.input.value = '/zzz';
  h.fns.refresh(h.cs, h.cs.pane);
  await h.answer([]);
  assert.equal(s.open, false);
  assert.ok(!h.calls.includes('ptyWrite'), 'nothing here ever touches the pty');
});

test('slash popup, run for real: arrows move the choice and wrap, Enter and Tab complete into the box and are CONSUMED (so Enter cannot send), Shift+Enter and IME are left alone', async () => {
  const h = slashHarness();
  h.cs.input.value = '/';
  h.fns.refresh(h.cs, h.cs.pane);
  await h.answer(ROWS);
  const s = h.cs.slash;
  const down = keyEv('ArrowDown');
  assert.equal(h.fns.key(h.cs, down), true);
  assert.equal(down.prevented, true);
  assert.equal(s.index, 1);
  assert.equal(h.cs.input.attrs['aria-activedescendant'], 'cs-slash-7-1');
  h.fns.key(h.cs, keyEv('ArrowDown')); h.fns.key(h.cs, keyEv('ArrowDown'));
  assert.equal(s.index, 0, 'wraps past the last row');
  h.fns.key(h.cs, keyEv('ArrowUp'));
  assert.equal(s.index, 2, 'wraps before the first row');
  // modified or composing keys are not the popup's
  for (const o of [{ isComposing: true }, { keyCode: 229 }, { metaKey: true }, { ctrlKey: true }, { altKey: true }]) assert.equal(h.fns.key(h.cs, keyEv('ArrowDown', o)), false, JSON.stringify(o));
  assert.equal(h.fns.key(h.cs, keyEv('Enter', { shiftKey: true })), false, 'Shift+Enter is a newline, and a newline closes the popup');
  assert.equal(h.fns.key(h.cs, keyEv('a')), false, 'typing is the box\'s own');
  // Enter completes the highlighted row — consumed, nothing sent, nothing written to the pty
  h.fns.move(h.cs, 1);
  const enter = keyEv('Enter');
  assert.equal(h.fns.key(h.cs, enter), true, 'Enter is consumed while the popup is open');
  assert.equal(enter.prevented, true);
  assert.equal(h.cs.input.value, '/deploy ', 'the command and a space, ready for its arguments');
  assert.deepEqual(h.cs.input.selection, [8, 8], 'the caret goes to the end');
  assert.equal(s.open, false);
  assert.equal(h.cs.input.attrs['aria-expanded'], 'false');
  assert.equal(h.cs.input.attrs['aria-activedescendant'], undefined);
  assert.ok(!h.calls.includes('ptyWrite'));
  // closed again: the same Enter is NOT consumed, so the sending listener gets it
  assert.equal(h.fns.key(h.cs, keyEv('Enter')), false);
  // Tab completes too
  h.cs.input.value = '/'; h.fns.refresh(h.cs, h.cs.pane); await h.answer(ROWS);
  assert.equal(h.fns.key(h.cs, keyEv('Tab')), true);
  assert.equal(h.cs.input.value, '/compact ');
  // a click completes the clicked row
  h.cs.input.value = '/'; h.fns.refresh(h.cs, h.cs.pane); await h.answer(ROWS);
  s.list.children[2].handlers.click[0]({});
  assert.equal(h.cs.input.value, '/aios:today ');
  // hover moves the choice (mousemove, not mouseover)
  h.cs.input.value = '/'; h.fns.refresh(h.cs, h.cs.pane); await h.answer(ROWS);
  s.list.children[1].handlers.mousemove[0]({});
  assert.equal(s.index, 1);
  assert.equal(s.list.children[0].handlers.mouseover, undefined);
});

guarded('Enter with the popup open completes and does NOT send: its listener is registered first and stops the event for the sending one',
  (src) => {
    const b = fnBody(slice(src), 'chatSkinBuild');
    const popAt = b.indexOf("input.addEventListener('keydown', (e) => { if (chatSkinSlashKey(cs, e)) e.stopImmediatePropagation(); });");
    const sendAt = b.indexOf('e.preventDefault();\n    chatSkinSendNow(id, p);');
    const key = fnBody(slice(src), 'chatSkinSlashKey');
    return popAt > 0 && sendAt > popAt
      && /e\.key === 'Enter' \|\| e\.key === 'Tab'\) && !e\.shiftKey\) \{ e\.preventDefault\(\); chatSkinSlashPick\(cs, s\.index\); return true; \}/.test(key)
      && !/chatSkinSendNow|submitToPty|ptyWrite/.test(key + fnBody(slice(src), 'chatSkinSlashPick'));
  },
  (src) => src.replace("if (chatSkinSlashKey(cs, e)) e.stopImmediatePropagation();", 'chatSkinSlashKey(cs, e);'));

guarded('Esc closes the slash popup and does NOT cut the turn: its listener runs before the interrupt one and stops the event',
  (src) => {
    const b = fnBody(slice(src), 'chatSkinBuild');
    const slashAt = b.indexOf("e.key !== 'Escape' || !cs.slash.open");
    const intrAt = b.indexOf('chatSkinInterrupt(id, p);\n  });');
    return slashAt > 0 && intrAt > slashAt
      && /stopImmediatePropagation\(\)/.test(b.slice(slashAt, intrAt)) && /chatSkinSlashClose\(cs\)/.test(b.slice(slashAt, intrAt))
      && !/chatSkinInterrupt/.test(b.slice(slashAt, intrAt).split('// Esc anywhere')[0]);
  },
  (src) => src.replace("e.preventDefault(); e.stopImmediatePropagation();\n    chatSkinSlashClose(cs);", 'e.preventDefault();\n    chatSkinSlashClose(cs);'));

test('Esc with the popup open, run for real, reaches the interrupt listener never: the two listeners in registration order', () => {
  // replay the skin's keydown listeners on `root` in the order they were registered, with a fake event that honours stopImmediatePropagation
  const b = fnBody(skin, 'chatSkinBuild');
  const listeners = [...b.matchAll(/root\.addEventListener\('keydown', \(e\) => \{([\s\S]*?)\n  \}\);/g)].map((m) => m[1]);
  assert.equal(listeners.length, 3, 'effort-menu Esc, popup Esc, interrupt');
  const interrupted: string[] = [];
  const run = (open: boolean): string[] => {
    interrupted.length = 0;
    const cs = { slash: { open }, effort: { open: false }, promptKind: null };
    const fns = listeners.map((body) => new Function('cs', 'e', 'chatSkinEffortMenu', 'chatSkinSlashClose', 'chatSkinInterrupt', 'id', 'p', body) as (...a: unknown[]) => void);
    let stopped = false;
    const e = { key: 'Escape', isComposing: false, preventDefault() { /* */ }, stopPropagation() { /* */ }, stopImmediatePropagation() { stopped = true; } };
    for (const fn of fns) { if (stopped) break; fn(cs, e, () => interrupted.push('effort'), () => interrupted.push('popup'), () => interrupted.push('INTERRUPT'), 1, {}); }
    return [...interrupted];
  };
  assert.deepEqual(run(true), ['popup'], 'the popup takes the key; the turn keeps running');
  assert.deepEqual(run(false), ['INTERRUPT'], 'control: with the popup closed the same key does reach the interrupt');
  // the effort menu, open: Esc closes it and nothing else (the same replay with the menu's flag up)
  const runEffort = (): string[] => {
    interrupted.length = 0;
    const cs = { slash: { open: false }, effort: { open: true }, promptKind: null };
    const fns = listeners.map((body) => new Function('cs', 'e', 'chatSkinEffortMenu', 'chatSkinSlashClose', 'chatSkinInterrupt', 'id', 'p', body) as (...a: unknown[]) => void);
    let stopped = false;
    const e = { key: 'Escape', isComposing: false, preventDefault() { /* */ }, stopPropagation() { /* */ }, stopImmediatePropagation() { stopped = true; } };
    for (const fn of fns) { if (stopped) break; fn(cs, e, (_cs: unknown, open: boolean) => interrupted.push('effort:' + (open ? 'open' : 'closed')), () => interrupted.push('popup'), () => interrupted.push('INTERRUPT'), 1, {}); }
    return [...interrupted];
  };
  assert.deepEqual(runEffort(), ['effort:closed'], 'the effort menu takes the key; the turn keeps running');
});

guarded('Esc closes the effort menu and does NOT cut the turn: its listener is registered before the interrupt one and stops the event for it',
  (src) => {
    const b = fnBody(slice(src), 'chatSkinBuild');
    const effAt = b.indexOf("e.key !== 'Escape' || !cs.effort.open");
    const intrAt = b.indexOf('chatSkinInterrupt(id, p);\n  });');
    const nextAt = b.indexOf("e.key !== 'Escape' || !cs.slash.open");
    const end = nextAt > effAt ? nextAt : intrAt;
    return effAt > 0 && intrAt > effAt && /stopImmediatePropagation\(\)/.test(b.slice(effAt, end)) && /chatSkinEffortMenu\(cs, false, true\)/.test(b.slice(effAt, end))
      && !/chatSkinInterrupt/.test(b.slice(effAt, end));
  },
  (src) => src.replace('e.preventDefault(); e.stopImmediatePropagation();\n    chatSkinEffortMenu(cs, false, true);', 'e.preventDefault();\n    chatSkinEffortMenu(cs, false, true);'));

// ── the effort menu ─────────────────────────────────────────────────────────

/** The verified words: what the installed CLI's /effort answers to (claude 2.1.311: `Usage: /effort [low|medium|high|xhigh|max|auto]`). */
const EFFORT_WORDS = ['low', 'medium', 'high', 'xhigh', 'max', 'auto'];
test('the effort menu offers exactly the words the installed CLI accepts, and the command hint says the same', () => {
  const menuList = /const CHAT_EFFORT_MENU = \[([^\]]+)\]/.exec(skin)?.[1] ?? '';
  assert.match(menuList, /\.\.\.CHAT_EFFORTS, CHAT_EFFORT_AUTO/);
  assert.match(skin, /const CHAT_EFFORT_AUTO = 'auto';/);
  const efforts = /const CHAT_EFFORTS = \[([^\]]+)\]/.exec(skin)?.[1].match(/'(\w+)'/g)?.map((x) => x.slice(1, -1)) ?? [];
  assert.deepEqual([...efforts, 'auto'], EFFORT_WORDS);
  assert.match(read('src/core/slashCommands.ts'), /\['effort', '\[low\|medium\|high\|xhigh\|max\|auto\]'\]/, 'the slash popup shows the same levels as its argument hint');
  // every level has a name and a one-line description in every language
  for (const l of Object.keys(loc)) for (const w of EFFORT_WORDS) for (const k of ['effort.' + w, 'chat.effort.desc.' + w, 'chat.bar.effort.' + w]) assert.ok(loc[l][k], `${l}.json lacks ${k}`);
  for (const l of Object.keys(loc)) for (const k of ['chat.effort.foot', 'chat.bar.effortTip', 'chat.bar.effortPick', 'chat.bar.effortAria', 'chat.bar.effortWord', 'chat.bar.effortMenu']) assert.ok(loc[l][k], `${l}.json lacks ${k}`);
  assert.equal(loc.en['chat.bar.effortTip'].includes('{level}'), true);
  assert.equal(loc.en['chat.bar.effortAria'].includes('{level}'), true);
  // control: a made-up level is not in the list
  assert.equal(EFFORT_WORDS.includes('ultra'), false);
});

guarded('choosing an effort types exactly `/effort <level>` through chatSkinSubmit, the one chokepoint — never a direct pty write',
  (src) => {
    const s = slice(src);
    const pick = fnBody(s, 'chatSkinEffortPick');
    return /chatSkinSubmit\(id, p, '\/effort ' \+ level\)/.test(pick) && !/ptyWrite|ptyRun|submitToPty/.test(pick)
      && /CHAT_EFFORT_MENU\.includes\(level\)/.test(pick)   // only the verified words can be typed
      && /chatSkinBarBlocked\(p\)/.test(pick)
      && /effortPop\.addEventListener\('click'[\s\S]*?chatSkinEffortPick\(id, p, b\.dataset\.level\)/.test(fnBody(s, 'chatSkinBuild'))
      && !/ptyWrite|ptyRun/.test(fnBody(s, 'chatSkinEffortMenu'));
  },
  (src) => src.replace("chatSkinSubmit(id, p, '/effort ' + level);", "window.glassShell.ptyWrite(id, '/effort ' + level + '\\r');"));

guarded('the command typed for an effort is the exact word of the CLI: `/effort` plus a space plus the level',
  (src) => /chatSkinSubmit\(id, p, '\/effort ' \+ level\)/.test(fnBody(slice(src), 'chatSkinEffortPick')),
  (src) => src.replace("chatSkinSubmit(id, p, '/effort ' + level);", "chatSkinSubmit(id, p, '/thinking ' + level);"));

guarded('the effort button is disabled under exactly the model button\'s conditions, from the same function, and an open menu closes when it becomes so',
  (src) => {
    const s = slice(src);
    const ctl = fnBody(s, 'chatSkinControls');
    const blocked = fnBody(s, 'chatSkinBarBlocked');
    return /const blocked = chatSkinBarBlocked\(p\);/.test(ctl) && /cs\.modelSeg\.disabled = blocked/.test(ctl) && /cs\.effortSeg\.disabled = blocked/.test(ctl)
      && /if \(blocked && cs\.effort\.open\) chatSkinEffortMenu\(cs, false\)/.test(ctl)
      && /chatSkinBarBlocked\(p\)/.test(fnBody(s, 'chatSkinModelMenu')) && /chatSkinBarBlocked\(p\)/.test(fnBody(s, 'chatSkinEffortPick'))
      && /chatSkinBarBlocked\(cs\.pane\)/.test(fnBody(s, 'chatSkinEffortMenu'))
      && /p\.exited/.test(blocked) && /cs\.promptKind/.test(blocked) && /chatSkinWorking\(p\)/.test(blocked);
  },
  (src) => src.replace('cs.effortSeg.disabled = blocked;', 'cs.effortSeg.disabled = !!p.exited;'));

test('the effort pick, run for real: it types the command, updates the segment at once, and does nothing while blocked or for a word that is not a level', () => {
  const pick = fnBody(skin, 'chatSkinEffortPick');
  assert.ok(pick.length > 100);
  const run = (blocked: boolean, level: string): { typed: string[]; effort: unknown; painted: number; closed: number } => {
    const typed: string[] = []; let painted = 0; let closed = 0;
    const cs = { status: { effort: 'low' } as Record<string, unknown> };
    const p = { chatSkin: cs, view: 'chat' };
    const panes = new Map([[7, p]]);
    const fn = new Function('chatSkinBarBlocked', 'CHAT_EFFORT_MENU', 'chatSkinEffortMenu', 'chatSkinSubmit', 'chatPaintUsage', 'chatSkinRefreshStatus', 'panes', 'setTimeout',
      `${pick}\nreturn chatSkinEffortPick;`)(() => blocked, ['low', 'medium', 'high', 'xhigh', 'max', 'auto'], () => { closed++; }, (_id: number, _p: unknown, text: string) => typed.push(text), () => { painted++; }, () => { /* */ }, panes, () => 0) as (id: number, p: unknown, l: string) => void;
    fn(7, p, level);
    return { typed, effort: cs.status.effort, painted, closed };
  };
  const ok = run(false, 'xhigh');
  assert.deepEqual(ok.typed, ['/effort xhigh']);
  assert.equal(ok.effort, 'xhigh', 'optimistic: the segment shows the choice before the payload confirms it');
  assert.equal(ok.painted, 1);
  assert.equal(ok.closed, 1, 'the menu closes on a pick');
  assert.deepEqual(run(false, 'auto').typed, ['/effort auto']);
  const blockedRun = run(true, 'high');
  assert.deepEqual(blockedRun.typed, [], 'blocked (a turn runs, a dialog is open): nothing is typed');
  assert.equal(blockedRun.effort, 'low', 'and nothing is claimed');
  assert.deepEqual(run(false, 'ultra').typed, [], 'a word that is not a verified level is never typed');
  assert.deepEqual(run(false, 'high; rm -rf').typed, [], 'nor anything with text after it');
});

test('the bar\'s block rule, run for real: a running turn, an open dialog or an ended session each block; an idle live one does not', () => {
  const fn = fnBody(skin, 'chatSkinBarBlocked');
  assert.ok(fn.length > 60);
  const blocked = (o: { exited?: boolean; promptKind?: string | null; working?: boolean; noSkin?: boolean }): boolean => {
    const cs = { promptKind: o.promptKind ?? null };
    const p = { chatSkin: o.noSkin ? null : cs, exited: !!o.exited };
    return (new Function('chatSkinWorking', `${fn}\nreturn chatSkinBarBlocked;`)(() => !!o.working) as (p: unknown) => boolean)(p);
  };
  assert.equal(blocked({}), false, 'idle and live: free');
  assert.equal(blocked({ working: true }), true, 'a turn is running');
  assert.equal(blocked({ promptKind: 'permission' }), true, 'a dialog is open');
  assert.equal(blocked({ exited: true }), true, 'the session ended');
  assert.equal(blocked({ noSkin: true }), true);
});

guarded('the effort menu is built as a menu of radio items outside the clipping bar, closes on a click outside, and marks the current level',
  (src) => {
    const s = slice(src);
    const b = fnBody(s, 'chatSkinBuild');
    const m = fnBody(s, 'chatSkinEffortMenu');
    return /effortPop\.setAttribute\('role', 'menu'\)/.test(b) && /setAttribute\('role', 'menuitemradio'\)/.test(b)
      && /wrap\.appendChild\(effortPop\)/.test(b) && !/bar\.append[^;]*effortPop|idBox\.append[^;]*effortPop/.test(b)   // the bar clips its overflow: the menu cannot live in it
      && /effortSeg\.setAttribute\('aria-haspopup', 'menu'\)/.test(b) && /setAttribute\('aria-expanded', String\(open\)\)/.test(m)
      && /addEventListener\('pointerdown', away, true\)/.test(m) && /removeEventListener\('pointerdown', away, true\)/.test(m)
      && /o\.setAttribute\('aria-checked', String\(o\.dataset\.level === now\)\)/.test(m)
      && /effortSeg\.addEventListener\('click', \(\) => chatSkinEffortMenu\(cs, !cs\.effort\.open\)\)/.test(b)
      && /focusout/.test(b) && /!on\) chatSkinEffortMenu\(cs, false\)/.test(fnBody(s, 'chatSkinLayout'));
  },
  (src) => src.replace("wrap.appendChild(effortPop);", "bar.appendChild(effortPop);"));

test('the effort menu\'s look: a neutral popover with its own tokens, a tick on the current level, no hex, and the same narrow-pane rule as before', () => {
  const rule = (sel: string): string => skinRules(css).find(([x]) => x === sel)?.[1] ?? [...css.matchAll(new RegExp(`^${sel.replace(/[.[\]]/g, '\\$&')} \\{([^}]*)\\}`, 'gm'))].map((m) => m[1]).join('');
  const pop = rule('.cb-pop');
  assert.match(pop, /position: absolute/);
  assert.match(pop, /background: var\(--chat-tip-bg\)/);
  assert.match(pop, /box-shadow: var\(--chat-pop\)/);
  assert.match(pop, /z-index: [6-9]/);
  assert.match(rule('.cbp-opt[aria-checked="true"]'), /background: var\(--chat-row-hover\)/);
  assert.match(rule('.cbp-opt[aria-checked="true"] .cs-ico'), /visibility: inherit/, 'never an explicit visibility:visible (it would punch through a hidden pane)');
  const whole = [...css.matchAll(/^\.(?:cb-pop|cbp-[a-z]+|cb-effort)[^{]*\{([^}]*)\}/gm)].map((m) => m[1]).join('\n');
  assert.ok(whole.length > 500);
  assert.doesNotMatch(whole, /#[0-9a-fA-F]{3,8}\b|\brgba?\(/);
  // the segment is a button with the model's affordances: a pointer, a hover fill that keeps the divider, a focus ring
  assert.match(css, /\.cb-effort \{ cursor: pointer; \}/);
  assert.match(css, /\.cb-effort:hover:not\(:disabled\), \.cb-effort\[aria-expanded="true"\] \{ background-color: var\(--chat-row-hover\); \}/);
  assert.match(css, /\.cb-effort:focus-visible \{ outline: 2px solid var\(--chat-focus\)/);
  // the narrow-pane step is still there (the effort is the first segment to go, after the labels)
  assert.match(css, /@container \(max-width: 410px\) \{ \.cb-effort \{ display: none; \} \}/);
});

test('the slash popup wires: the box is a combobox over a listbox, input asks, send/hide/blocked close it, and the IPC is read-only with a leading-slash gate', () => {
  const b = fnBody(skin, 'chatSkinBuild');
  assert.match(b, /slashList\.setAttribute\('role', 'listbox'\)/);
  assert.match(b, /input\.setAttribute\('role', 'combobox'\)/);
  assert.match(b, /input\.setAttribute\('aria-autocomplete', 'list'\)/);
  assert.match(b, /input\.setAttribute\('aria-controls', slashList\.id\)/);
  assert.match(b, /slashFoot\.setAttribute\('aria-hidden', 'true'\)/, 'the footer hint is not read inside the listbox');
  assert.match(b, /wrap\.append\(slashPop, box\)/, 'the popup floats against the card');
  assert.match(b, /slashPop\.addEventListener\('mousedown', \(e\) => e\.preventDefault\(\)\)/, 'a press on a row keeps the caret in the box');
  assert.match(b, /input\.addEventListener\('input', \(\) => \{ chatSkinAutosize\(cs\); chatSkinControls\(p\); chatSkinSlashRefresh\(cs, p\); \}\)/);
  assert.match(b, /input\.addEventListener\('blur', \(\) => chatSkinSlashClose\(cs\)\)/);
  assert.match(fnBody(skin, 'chatSkinSendNow'), /chatSkinSlashClose\(cs\)/);
  assert.match(fnBody(skin, 'chatSkinLayout'), /if \(!on \|\| cs\.promptKind\) chatSkinSlashClose\(cs\)/);
  // the popup only completes: nothing in it writes to the pty or submits
  const block = skin.slice(skin.indexOf('function chatSkinSlashRefresh('), skin.indexOf('/* Which glyph a tool wears'));
  assert.doesNotMatch(block, /ptyWrite|submitToPty|chatSkinSendNow|innerHTML/);
  // the command rows only ever take text through textContent (el(tag, class, text))
  assert.match(block, /el\('span', 'csl-desc', c\.descKey \? t\(c\.descKey\) : String\(c\.description \|\| ''\)\)/);
  // main and the preload agree on the channel; main reads only, gates on a leading slash and caps the text
  assert.match(preload, /slashCommands: \(cwd: string \| null, text: string\): Promise<SlashCommand\[\]> => ipcRenderer\.invoke\('slashCommands:list', cwd, text\)/);
  const h = /ipcMain\.handle\('slashCommands:list'[\s\S]*?\n\}\);/.exec(main)?.[0] ?? '';
  assert.match(h, /text\.length > 200 \|\| text\.charCodeAt\(0\) !== 47\) return \[\]/);
  assert.match(h, /path\.isAbsolute\(cwd\)/);
  assert.match(h, /slashSuggestions\(await hit\.list, text\)/);
  assert.match(h, /aios\.claudeConfigDir\(\)[\s\S]*aios\.discoverCommands\(\)/);
  assert.doesNotMatch(h, /writeFile|appendFile|rm\(|unlink|spawn|exec/, 'the handler only reads');
  // control: a handler that did not gate on the slash would list commands for any text
  assert.doesNotMatch(h.replace('text.charCodeAt(0) !== 47', 'false'), /charCodeAt\(0\) !== 47/);
});

test('the slash popup\'s CSS: neutral, above the card, scrolls, rows are options with a visible active state, narrow panes stack the description', () => {
  const rules = skinRules(css);
  const rule = (sel: string): string => rules.find(([s]) => s === sel)?.[1] ?? '';
  assert.match(rule('.cc-slash'), /position: absolute[\s\S]*bottom: calc\(100% \+ 8px\)/);
  assert.match(rule('.cc-slash'), /max-height: min\(332px, 52vh\)/);
  assert.match(rule('.csl-list'), /overflow-y: auto/);
  assert.match(rule('.csl-row.on'), /background: var\(--chat-row-hover\)/);
  assert.ok(!coralUsers(css).some((s) => /csl|cc-slash/.test(s)), 'no coral in the popup');
  assert.ok(rules.some(([s, d]) => s === '.csl-desc' && /flex: 1 1 100%/.test(d)), 'a narrow container stacks the description under the name');
  assert.match(rule('.csl-row'), /grid-template-columns: subgrid/, 'wide rows share their columns');
  assert.match(rule('.chatskin [hidden]') + css, /\.chatskin\[hidden\], \.chatskin \[hidden\] \{ display: none !important; \}/, 'hidden stays hidden');
});

test('the slash popup, polished: usage hints cut at a word, at most seven rows, a fade says there is more, the origin is a whisper not a capsule', () => {
  // the shortener, from the real source: whole short hints pass through; long ones lose words, never half a word, and keep their brackets
  const from = skin.indexOf('const CHAT_SLASH_HINT_MAX'); const to = skin.indexOf('function chatSkinSlashFade(');
  assert.ok(from > 0 && to > from, 'the shortener was found');
  const hint = new Function(`${skin.slice(from, to)}\nreturn chatSkinSlashHint;`)() as (h: string) => string;
  assert.equal(hint('[branch]'), '[branch]');
  assert.equal(hint(''), '');
  assert.equal(hint('<optional custom summarization instructions>'), '<optional custom…>');
  assert.equal(hint('[conversation id or search term]'), '[conversation id…]', 'never ends on a dangling joiner');
  assert.equal(hint('averyveryveryverylongsingleword'), 'averyveryveryverylong…', 'one long word has no boundary: the CSS ellipsis is the net');
  for (const h of ['<optional custom summarization instructions>', '[conversation id or search term]', 'x'.repeat(60)]) assert.ok(hint(h).length <= 22, `"${hint(h)}" fits the column`);
  // negative control: a shortener that cut blindly would split the word
  assert.notEqual('<optional custom summarization instructions>'.slice(0, 21) + '…', hint('<optional custom summarization instructions>'));
  // the CSS: seven rows, a mask that follows the more-t / more-b classes, an origin with no border and no pill radius
  const rules = skinRules(css);
  const rule = (sel: string): string => rules.find(([x]) => x === sel)?.[1] ?? '';
  assert.match(rule('.csl-list'), /--csl-row: 28px/);
  assert.match(rule('.csl-list'), /max-height: calc\(7 \* var\(--csl-row\)\)/);
  assert.match(rule('.csl-list'), /mask-image: linear-gradient/);
  assert.match(rule('.csl-list.more-b'), /--csl-fb: \d+px/);
  assert.match(rule('.csl-list'), /scroll-padding: 16px 5px 22px/, 'the active row is never parked under the fade');
  assert.doesNotMatch(rule('.csl-tag'), /border|border-radius|background/, 'the origin is text, not a capsule');
  assert.match(rule('.csl-tag'), /font-size: 10px/);
  assert.match(fnBody(skin, 'chatSkinSlashMove'), /scrollIntoView\(\{ block: 'nearest' \}\)/, 'the active row is scrolled into view when the arrows move it');
  assert.match(fnBody(skin, 'chatSkinSlashFade'), /more-t[\s\S]*more-b/);
});

test('the empty card: a name, a sentence and three keys, every word through t(), the keys only when the view is empty', () => {
  const paint = fnBody(skin, 'chatSkinPaintState');
  assert.match(paint, /cs\.stateTips\) cs\.stateTips\.hidden = kind !== 'empty'/);
  assert.match(paint, /t\(key \+ '\.title', \{ name: chatSkinWho\(p\) \}\)/, 'the title carries the session name');
  for (const k of ['chat.skin.empty.tip.slash', 'chat.skin.empty.tip.send', 'chat.skin.empty.tip.newline']) {
    assert.ok(skin.includes(`'${k}'`), `the card builds ${k}`);
    for (const l of Object.keys(loc)) assert.ok(typeof loc[l][k] === 'string' && loc[l][k].length > 0, `${l}.json lacks ${k}`);
  }
  for (const l of Object.keys(loc)) assert.match(loc[l]['chat.skin.state.empty.title'], /\{name\}/, `${l}: the empty title names the session`);
  assert.match(css, /\.csc-title \{[^}]*color: var\(--ink\)/, 'the title has an explicit ink: a card has no message around it to inherit from');
});

test('the vertical scale: one set of spacing variables on the skin, used by rows, tools, notes and markdown blocks alike', () => {
  const rules = skinRules(css);
  const decl = (sel: string): string => rules.filter(([x]) => x === sel).map(([, d]) => d).join(' ');
  assert.match(decl('.chatskin'), /--cs-m: 7px; --cs-turn: 19px; --cs-blk: \.85em; --cs-sec: 1\.4em/);
  assert.match(decl('.chat-row.who-user'), /margin: var\(--cs-turn\) 0 var\(--cs-m\)/);
  assert.match(decl('.chat-row.who-claude'), /margin: var\(--cs-m\) 0/);
  assert.match(decl('.chat-tool, .chat-tg'), /margin: var\(--cs-m\) 0/);
  assert.match(decl('.cm-code'), /margin: 0 0 var\(--cs-blk\)/);
  assert.match(decl('.cm-table'), /margin: 0 0 var\(--cs-blk\)/);
  assert.match(decl('.chat-md p, .chat-md ul, .chat-md ol, .chat-md blockquote, .chat-md pre, .chat-md table'), /margin: 0 0 var\(--cs-blk\)/);
  // the operator's bubble: smaller padding and radius than it had (10px 15px, 16px), a lighter skin
  assert.match(decl('.who-user .chat-bubble'), /padding: 7px 13px 8px/);
  assert.match(decl('.who-user .chat-bubble'), /border-radius: 14px 14px 4px 14px/);
  assert.doesNotMatch(decl('.who-user .chat-bubble'), /box-shadow/);
});

test('the slash popup\'s sentences exist in every locale with the same placeholders', () => {
  for (const k of ['chat.slash.label', 'chat.slash.foot', 'chat.slash.src.project', 'chat.slash.src.user']) for (const l of Object.keys(loc)) assert.ok(typeof loc[l][k] === 'string' && loc[l][k].length > 0, `${l}.json lacks ${k}`);
  // every key the popup builds from a command (descKey) is in the main process's list: the two cannot drift
  const keys = [...fs.readFileSync('src/core/slashCommands.ts', 'utf8').matchAll(/^  \['([a-z0-9-]+)'/gm)].map((m) => `chat.slash.cmd.${m[1]}`);
  assert.ok(keys.length >= 60);
  for (const l of Object.keys(loc)) assert.deepEqual(keys.filter((k) => !loc[l][k]), [], `${l}.json lacks descriptions`);
});

test('chat-shot fixture: the slash popup is shot open (all sources, filtered, narrow, and through the real IPC) in dark and light', () => {
  const byName = (n: string): FxShot | undefined => fixture.shots.find((s) => s.name === n);
  for (const n of ['slash-dark', 'slash-light', 'slash-filter-dark', 'slash-filter-light', 'slash-live-dark', 'slash-narrow-dark', 'slash-narrow-light']) assert.ok(byName(n), `missing shot ${n}`);
  const js = (n: string): string => [byName(n)?.js].flat().join('\n');
  assert.match(js('slash-dark'), /chatSkinSlashShow\(/);
  assert.match(js('slash-live-dark'), /dispatchEvent\(new Event\('input'/, 'the live shot goes through the real input listener and the real slashCommands IPC');
  // the hand-written rows cover every source and a built-in described through its locale key
  const rows = JSON.parse(/chatSkinSlashShow\(ctx\.cs, (\[[\s\S]*?\])\);/.exec(js('slash-dark'))?.[1] ?? '[]') as Array<{ source: string; descKey?: string; name: string }>;
  assert.deepEqual([...new Set(rows.map((r) => r.source))].sort(), ['builtin', 'plugin', 'project', 'user']);
  assert.ok(rows.some((r) => r.descKey && loc.en[r.descKey]), 'built-in rows name a real description key');
});

// ── files into the box: drop and paste ──────────────────────────────────────

interface DropHarness {
  cs: { input: FakeNode; box: FakeNode; pane: { el: { classList: { remove: (c: string) => void } } } };
  calls: string[]; saved: Array<[number, string]>; toasts: string[];
  fire: (zone: FakeNode, ev: string, e: Record<string, unknown>) => Promise<void>;
}
/** The drop/paste code from the real source, wired to fakes. `savedPath` is what main would answer for a picture with no file. */
function dropHarness(src: string = skin, o: { savedPath?: string | null; realPath?: (f: { name: string }) => string } = {}): DropHarness {
  const from = src.indexOf('function chatSkinQuotePath(');
  const to = src.indexOf('/* Which glyph a tool wears');
  assert.ok(from > 0 && to > from, 'the drop block was found');
  const calls: string[] = []; const saved: Array<[number, string]> = []; const toasts: string[] = [];
  const glassShell = {
    pathForFile: (f: { name: string }): string => (o.realPath ? o.realPath(f) : `/Users/op/${f.name}`),
    chatSavePastedImage: async (buf: { byteLength: number }, mime: string): Promise<string | null> => { saved.push([buf.byteLength, mime]); return o.savedPath === undefined ? '/tmp/aios-chat-paste/paste-1-abc.png' : o.savedPath; },
    ptyWrite: (): void => { calls.push('ptyWrite'); },
  };
  const make = new Function('window', 'xQuote', 'droppedPaths', 'clearDragging', 'toast', 't', 'chatSkinSlashClose', 'chatSkinAutosize', 'chatSkinControls',
    `${src.slice(from, to)}\nreturn { bind: chatSkinDropBind };`) as (...a: unknown[]) => { bind: (cs: unknown) => void };
  const input = new FakeNode('textarea'); const box = new FakeNode('div');
  const cs = { input, box, pane: { el: { classList: { remove: (c: string): void => { calls.push('pane-remove-' + c); } } } } };
  make({ glassShell }, (p: string) => `'${p}'`, (ev: { dataTransfer: { getData: (t: string) => string } }) => (ev.dataTransfer.getData('text/uri-list') || '').split('\n').filter(Boolean).map((u) => u.replace(/^file:\/\//, '')),
    () => calls.push('clearDragging'), (m: string) => toasts.push(m), (k: string) => `«${k}»`, () => calls.push('slashClose'), () => calls.push('autosize'), () => calls.push('controls')).bind(cs);
  return { cs, calls, saved, toasts, fire: async (zone, ev, e) => { for (const fn of zone.handlers[ev] || []) fn(e); await new Promise((r) => setTimeout(r, 0)); } };
}
interface FakeDrop { stops: number; prevents: number; [k: string]: unknown }
const dropEv = (o: { types?: string[]; data?: Record<string, string>; files?: Array<{ name: string; type?: string; size?: number }> } = {}): FakeDrop => {
  const e: FakeDrop = {
    stops: 0, prevents: 0, relatedTarget: null,
    dataTransfer: { types: o.types ?? ['Files'], getData: (t: string) => o.data?.[t] ?? '', files: (o.files ?? []).map((f) => ({ type: '', size: 3, arrayBuffer: async () => ({ byteLength: f.size ?? 3 }), ...f })), dropEffect: '' },
    preventDefault() { e.prevents++; }, stopPropagation() { e.stops++; },
  };
  return e;
};

test('drop and paste, run for real: a dropped file lands at the caret as a double-quoted absolute path, never sent, and the pane under the card never hears of it', async () => {
  const h = dropHarness();
  const zone = h.cs.box;
  // dragover: accepted, copy cursor, the card lights up, the pane's own zone is told to dim and the event stops here
  const over = dropEv();
  await h.fire(zone, 'dragover', over);
  assert.equal(over.prevents, 1); assert.equal(over.stops, 1);
  assert.match(zone.className, /dropok/);
  assert.ok(h.calls.includes('pane-remove-dropok'), 'the pane\'s coral drop ring does not light up behind the card');
  // a tab being reordered is not a file: not accepted, not stopped
  const tab = dropEv({ types: ['application/x-aios-tab', 'text/plain'] });
  await h.fire(zone, 'dragover', tab);
  assert.equal(tab.prevents, 0);
  // an empty box: the path alone, quoted, with a space after so typing continues
  const drop = dropEv({ files: [{ name: 'My Notes v2.pdf' }] });
  await h.fire(zone, 'drop', drop);
  assert.equal(h.cs.input.value, '"/Users/op/My Notes v2.pdf" ');
  assert.deepEqual(h.cs.input.selection, [h.cs.input.value.length, h.cs.input.value.length]);
  assert.equal(drop.stops, 1, 'the drop stops here: the pane\'s terminal zone would write the path to the pty'); assert.equal(drop.prevents, 1);
  assert.ok(!/dropok/.test(zone.className), 'the veil is gone after the drop');
  assert.ok(!h.calls.includes('ptyWrite'), 'the drop only edits the box');
  // text already in the box: a space is added before the path when needed, and the caret decides where it lands
  h.cs.input.value = 'look at'; h.cs.input.selection = [7, 7];
  await h.fire(zone, 'drop', dropEv({ files: [{ name: 'a.png' }, { name: 'b.png' }] }));
  assert.equal(h.cs.input.value, 'look at "/Users/op/a.png" "/Users/op/b.png" ');
  h.cs.input.value = 'compare  and then'; h.cs.input.selection = [8, 8];
  await h.fire(zone, 'drop', dropEv({ files: [{ name: 'c.png' }] }));
  assert.equal(h.cs.input.value, 'compare "/Users/op/c.png" and then', 'in the middle: one space each side, none doubled');
  // one of our explorer rows
  h.cs.input.value = ''; h.cs.input.selection = [0, 0];
  await h.fire(zone, 'drop', dropEv({ types: ['application/x-aios-path', 'text/plain'], data: { 'application/x-aios-path': '/work/app/src' } }));
  assert.equal(h.cs.input.value, '"/work/app/src" ');
  // plain text: the textarea's own business — the drop still stops here (so the pane's zone does not write it to the pty) but nothing is inserted by us
  h.cs.input.value = ''; h.cs.input.selection = [0, 0];
  const text = dropEv({ types: ['text/plain'], data: { 'text/plain': 'hello' } });
  await h.fire(zone, 'drop', text);
  assert.equal(text.stops, 1); assert.equal(text.prevents, 0); assert.equal(h.cs.input.value, '');
  assert.ok(!h.calls.includes('ptyWrite'));
});

test('drop and paste, run for real: a picture with no file behind it is saved by main and its path inserted; anything else that cannot be attached says so once', async () => {
  const h = dropHarness();
  // an image dragged out of a browser: no path from the OS, the bytes go to main, the temp path comes back
  const real = (f: { name: string }): string => (/^(photo|image)\.png$/.test(f.name) ? '' : `/Users/op/${f.name}`);
  const h2 = dropHarness(skin, { realPath: real });
  await h2.fire(h2.cs.box, 'drop', dropEv({ files: [{ name: 'photo.png', type: 'image/png', size: 2048 }] }));
  assert.deepEqual(h2.saved, [[2048, 'image/png']]);
  assert.equal(h2.cs.input.value, '"/tmp/aios-chat-paste/paste-1-abc.png" ');
  // a paste of that same picture: native paste is cancelled, the same path is inserted
  const pasteEv = { clipboardData: { files: [{ name: 'image.png', type: 'image/png', size: 10, arrayBuffer: async () => ({ byteLength: 10 }) }] }, prevents: 0, preventDefault() { pasteEv.prevents++; } };
  h2.cs.input.value = 'what is wrong here?'; h2.cs.input.selection = [19, 19];
  await h2.fire(h2.cs.input, 'paste', pasteEv);
  assert.equal(pasteEv.prevents, 1);
  assert.equal(h2.cs.input.value, 'what is wrong here? "/tmp/aios-chat-paste/paste-1-abc.png" ');
  // control: a text paste has no files, so it is left to the textarea (we never cancel it)
  const textPaste = { clipboardData: { files: [] }, prevents: 0, preventDefault() { textPaste.prevents++; } };
  await h2.fire(h2.cs.input, 'paste', textPaste);
  assert.equal(textPaste.prevents, 0);
  // not an image and no path (or main refused): nothing inserted, one message
  const h3 = dropHarness(skin, { realPath: () => '', savedPath: null });
  await h3.fire(h3.cs.box, 'drop', dropEv({ files: [{ name: 'x.bin', type: 'application/octet-stream' }, { name: 'y.png', type: 'image/png' }] }));
  assert.equal(h3.cs.input.value, '');
  assert.deepEqual(h3.toasts, ['«chat.drop.failed»'], 'once, however many files failed');
  assert.equal(h3.saved.length, 1, 'only the picture is offered to main');
  assert.ok(h.calls.length === 0 || !h.calls.includes('ptyWrite'));
  // a double quote in a path falls back to the shell-style quote rather than a broken pair
  const h4 = dropHarness(skin, { realPath: () => '/Users/op/say "hi".png' });
  await h4.fire(h4.cs.box, 'drop', dropEv({ files: [{ name: 'q.png' }] }));
  assert.equal(h4.cs.input.value, `'/Users/op/say "hi".png' `);
});

guarded('the drop on the card inserts the double-quoted absolute path and stops the event, so the pane under it does not also write to the pty',
  (src) => {
    const s = slice(src);
    const quote = fnBody(s, 'chatSkinQuotePath');
    const bind = fnBody(s, 'chatSkinDropBind');
    const insert = fnBody(s, 'chatSkinInsertPaths');
    const dropAt = bind.indexOf("zone.addEventListener('drop'");
    const stopAt = bind.indexOf('ev.stopPropagation();', dropAt);
    const guardAt = bind.indexOf('if (!wants(ev)) return;', dropAt);
    return /'"' \+ s \+ '"'/.test(quote)
      && dropAt > 0 && stopAt > dropAt && stopAt < guardAt   // stopped BEFORE the early return: a text drop must not fall through to the pane either
      && /chatSkinInsertPaths\(cs, paths\)/.test(bind) && /paths\.map\(chatSkinQuotePath\)/.test(insert)
      && !/ptyWrite|submitToPty|chatSkinSendNow/.test(quote + bind + insert + fnBody(s, 'chatSkinFilePaths'));
  },
  (src) => src.replace("    // ALWAYS stop it here: a drop of plain text on the box is the textarea's own (it inserts the text), and must not also reach the pane's zone\n    ev.stopPropagation();\n", ''));

guarded('a path is only ever quoted with double quotes unless it holds one itself, and a dragover over the card never lights the pane\'s coral ring',
  (src) => {
    const s = slice(src);
    return /return s\.includes\('"'\) \? xQuote\(s\) : '"' \+ s \+ '"'/.test(fnBody(s, 'chatSkinQuotePath'))
      && /cs\.pane\.el\?\.classList\.remove\('dropok'\)/.test(fnBody(s, 'chatSkinDropBind'));
  },
  (src) => src.replace("return s.includes('\"') ? xQuote(s) : '\"' + s + '\"';", 'return xQuote(s);'));

test('drop and paste: the picture-saving IPC is bounded, names its own file, sweeps only its own files, and the card has a neutral drop veil', () => {
  assert.match(preload, /chatSavePastedImage: \(bytes: ArrayBuffer, mime: string\): Promise<string \| null> => ipcRenderer\.invoke\('chatFiles:savePastedImage', bytes, mime\)/);
  const h = /ipcMain\.handle\('chatFiles:savePastedImage'[\s\S]*?\n\}\);/.exec(main)?.[0] ?? '';
  assert.ok(h.length > 400, 'handler found');
  assert.match(h, /PASTE_EXT\[mime\.toLowerCase\(\)\]/, 'only the image types on the allow-list');
  assert.match(main, /const PASTE_MAX_BYTES = 25 \* 1024 \* 1024/);
  assert.match(h, /buf\.length > PASTE_MAX_BYTES\) return null/);
  assert.match(h, /path\.join\(fs\.realpathSync\(os\.tmpdir\(\)\), 'aios-chat-paste'\)/, 'one folder under the system temp');
  assert.match(h, /paste-\$\{Date\.now\(\)\}-\$\{crypto\.randomBytes\(3\)\.toString\('hex'\)\}\.\$\{ext\}/, 'main names the file; the renderer chooses no path or extension');
  assert.match(h, /\^paste-\[\\w-\]\+\\\.\(png\|jpg\|gif\|webp\)\$/, 'the sweep only touches files that look like its own');
  assert.match(h, /mode: 0o600/);
  assert.doesNotMatch(h, /\.\.\/|ev\.|_e\./, 'no renderer-supplied path anywhere');
  // control: a handler that took the file name from the renderer would show up as a second parameter being joined into the path
  assert.doesNotMatch(h.replace('paste-${Date.now()}', '${name}'), /paste-\$\{Date\.now\(\)\}/);
  const rules = skinRules(css);
  const rule = (sel: string): string => rules.find(([s]) => s === sel)?.[1] ?? '';
  assert.match(rule('.cc-drop'), /pointer-events: none/);
  assert.match(rule('.cc-drop'), /border: 1\.5px dashed var\(--line-strong\)/);
  assert.ok(!coralUsers(css).some((s) => /cc-drop|dropok/.test(s) && !/termcard/.test(s)), 'no coral on the card\'s drop veil');
  for (const l of Object.keys(loc)) for (const k of ['chat.drop.label', 'chat.drop.failed']) assert.ok(typeof loc[l][k] === 'string' && loc[l][k].length > 0, `${l}.json lacks ${k}`);
});

test('chat-shot fixture: the drop veil and an inserted pair of paths are shot in dark and light, with paths that name nothing personal', () => {
  const byName = (n: string): FxShot | undefined => fixture.shots.find((s) => s.name === n);
  for (const n of ['drop-over-dark', 'drop-over-light', 'drop-inserted-dark', 'drop-inserted-light']) assert.ok(byName(n), `missing shot ${n}`);
  assert.match([byName('drop-over-dark')?.js].flat().join('\n'), /box\.classList\.add\('dropok'\)/, 'the veil is forced by the fixture');
  const ins = [byName('drop-inserted-light')?.js].flat().join('\n');
  assert.match(ins, /chatSkinInsertPaths\(ctx\.cs, \['\/work\/app\//, 'it goes through the real insert function, with neutral paths');
});

// ── streaming: the reply being written, as ONE provisional bubble the finished message takes over ──────────

/** A DOM stand-in rich enough for the column code: ordered children, classes, attributes, a class-selector query, focus. */
class Dn {
  tag: string; className: string; textContent: string; hidden = false; disabled = false; dataset: Record<string, string> = {}; attrs: Record<string, string> = {};
  id = ''; children: Dn[] = []; parent: Dn | null = null; handlers: Record<string, Array<(e: unknown) => void>> = {}; value = ''; renders = 0;
  static active: Dn | null = null;
  constructor(tag = 'div', cls = '', text = '') { this.tag = tag; this.className = cls; this.textContent = text; }
  private cls(): Set<string> { return new Set(this.className.split(/\s+/).filter(Boolean)); }
  classList = {
    add: (...c: string[]): void => { const s = this.cls(); c.forEach((x) => s.add(x)); this.className = [...s].join(' '); },
    remove: (...c: string[]): void => { const s = this.cls(); c.forEach((x) => s.delete(x)); this.className = [...s].join(' '); },
    contains: (c: string): boolean => this.cls().has(c),
    toggle: (c: string, on?: boolean): void => { const s = this.cls(); if (on === undefined ? !s.has(c) : on) s.add(c); else s.delete(c); this.className = [...s].join(' '); },
  };
  insertBefore(n: Dn, ref: Dn | null): Dn { n.remove(); const i = ref ? this.children.indexOf(ref) : -1; this.children.splice(i < 0 ? this.children.length : i, 0, n); n.parent = this; return n; }
  appendChild(n: Dn): Dn { return this.insertBefore(n, null); }
  append(...ns: Dn[]): void { ns.forEach((n) => this.appendChild(n)); }
  remove(): void { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } }
  replaceChildren(...ns: Dn[]): void { this.children.forEach((c) => { c.parent = null; }); this.children = []; ns.forEach((n) => this.appendChild(n)); }
  setAttribute(k: string, v: string): void { this.attrs[k] = v; }
  removeAttribute(k: string): void { delete this.attrs[k]; }
  getAttribute(k: string): string | null { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(ev: string, fn: (e: unknown) => void): void { (this.handlers[ev] ||= []).push(fn); }
  focus(): void { Dn.active = this; }
  click(): void { if (this.disabled) return; for (const fn of this.handlers.click ?? []) fn({ target: this, preventDefault: () => undefined }); this.parent?.bubble('click', this); }
  /** a click on a child reaches the listeners of its ancestors (the card delegates its clicks to the list) */
  bubble(ev: string, target: Dn): void { for (const fn of this.handlers[ev] ?? []) fn({ target, preventDefault: () => undefined }); this.parent?.bubble(ev, target); }
  closest(sel: string): Dn | null { for (let n: Dn | null = this; n; n = n.parent) if (n.matches(sel)) return n; return null; }
  private matches(sel: string): boolean {
    const notDisabled = sel.includes(':not(:disabled)');
    const classes = sel.replace(':not(:disabled)', '').split('.').filter(Boolean);
    return classes.every((c) => this.cls().has(c)) && (!notDisabled || !this.disabled);
  }
  querySelectorAll(sel: string): Dn[] { const out: Dn[] = []; const walk = (n: Dn): void => { for (const c of n.children) { if (c.matches(sel)) out.push(c); walk(c); } }; walk(this); return out; }
  querySelector(sel: string): Dn | null { return this.querySelectorAll(sel)[0] ?? null; }
}
const isProv = (n: Dn): boolean => n.classList.contains('cs-prov');

interface StreamHarness { cs: Record<string, any>; handle: (ev: Record<string, unknown>) => void; p: Record<string, any>; scrolls: unknown[]; links: Array<{ node: Dn; text: string }> } // eslint-disable-line @typescript-eslint/no-explicit-any
/** The column code (items, the provisional bubble, adoption, the event switch) from the real source, wired to stand-ins. */
function streamHarness(src: string = app, lang: 'en' | 'es' | 'pt-br' = 'en'): StreamHarness {
  const from = src.indexOf('function chatToolInfo(');
  const to = src.indexOf('if (window.glassShell && typeof window.glassShell.onChatSkinEvent');
  assert.ok(from > 0 && to > from, 'the column block was found');
  const make = new Function('el', 't', 'chatRender', 'chatSkinMakeTool', 'chatSkinPaintTool', 'chatSkinScroll', 'chatSkinPaintJump', 'chatSkinControls', 'chatSkinPaintAlert', 'chatSkinPaintState',
    'chatSkinCardPaint', 'chatSkinPrompt', 'chatReducedMotion', 'CS_ANIM_AFTER_MS', 'panes', 'csIcon', 'chatLinkPaths',
    `${src.slice(from, to)}\nreturn chatSkinHandleEvent;`) as (...a: unknown[]) => (ev: Record<string, unknown>) => void;
  const log = new Dn('div', 'chat-log');
  const stateEl = new Dn('div', 'cs-card'); const workEl = new Dn('div', 'cs-working');
  log.append(stateEl, workEl);
  const p: Record<string, any> = { name: 'chat-qa', view: 'chat' }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const cs: Record<string, any> = { log, stateEl, workEl, items: new Map(), groups: new Map(), groupOpen: new Map(), stream: null, dlg: null, dlgSig: '', turnOpen: false, stalled: false, state: 'waiting', stick: true, resetAt: 0, lastEventAt: 0, lastSubmitAt: 0, pane: p }; // eslint-disable-line @typescript-eslint/no-explicit-any
  p.chatSkin = cs;
  const scrolls: unknown[] = [];
  const links: Array<{ node: Dn; text: string }> = [];   // every block chatLinkPaths was asked to link, with the text it held at that moment
  const tr = (k: string, v?: Record<string, unknown>): string => String(loc[lang][k] ?? k).replace(/\{(\w+)\}/g, (_m, n: string) => (v && n in v ? String(v[n]) : `{${n}}`));
  const handle = make((tag: string, cls?: string, text?: string) => new Dn(tag, cls, text), tr,
    (target: Dn, text: string) => { target.textContent = text; target.renders++; },
    () => ({ node: new Dn('div', 'chat-tool'), body: null, role: 'tool', tool: {} }), () => undefined, (c: unknown) => { scrolls.push(c); }, () => undefined, () => undefined, () => undefined, () => undefined,
    () => undefined, () => undefined, () => false, 1500, new Map([[1, p]]), (name: string) => { const d = new Dn('span', 'cs-ico'); d.attrs['data-icon'] = name; return d; },
    (node: Dn) => { links.push({ node, text: String(node.textContent) }); });
  return { cs, p, scrolls, links, handle: (ev) => handle({ paneId: 1, ...ev }) };
}
const rowsOf = (cs: StreamHarness['cs']): Dn[] => (cs.log as Dn).children.filter((c) => c.className.includes('who-claude'));

/** The scenario every streaming guard reads: a message, text growing in three snapshots, then the finished message. */
function streamRun(src: string): { provisionals: number; sameNode: boolean; stillProvisional: boolean; sameSlot: boolean; answerRows: number; finalText: string; renderedOnce: boolean; ariaHiddenGone: boolean } {
  const { cs, handle } = streamHarness(src);
  handle({ type: 'items', items: [{ uuid: 'u1', role: 'user', text: 'explain the cap' }] });
  handle({ type: 'turn', open: true });
  handle({ type: 'stream', text: 'The cap', anchor: 'the cap', headCut: false });
  handle({ type: 'stream', text: 'The cap is enforced in nextDelay', anchor: 'the cap is enforced in nextdelay', headCut: false });
  handle({ type: 'stream', text: 'The cap is enforced in nextDelay: the smaller of both.', anchor: 'the cap is enforced in nextdelay', headCut: false });
  const log = cs.log as Dn;
  const provs = log.children.filter(isProv);
  const slot = log.children.indexOf(provs[0]);
  const rendersBefore = provs[0]?.querySelector('.chat-md')?.renders ?? 0;
  handle({ type: 'stream', text: null, adopt: 'a1' });
  handle({ type: 'items', items: [{ uuid: 'a1', role: 'assistant', text: 'The cap is enforced in `nextDelay`: the smaller of both.' }] });
  handle({ type: 'turn', open: false });
  const rec = cs.items.get('a1');
  return {
    provisionals: provs.length, sameNode: !!rec && rec.node === provs[0], stillProvisional: !!provs[0] && isProv(provs[0]),
    sameSlot: !!provs[0] && log.children.indexOf(provs[0]) === slot && slot > 0, answerRows: rowsOf(cs).length,
    finalText: rec ? String(rec.body.textContent) : '', renderedOnce: rendersBefore >= 3, ariaHiddenGone: !!provs[0] && provs[0].getAttribute('aria-hidden') === null,
  };
}

/** Paths become links on the FINISHED message only: how many times chatLinkPaths ran while the preview grew, and for what, once the real message landed. */
function linkRun(src: string): { whileStreaming: number; afterwards: string[]; user: string[] } {
  const { cs, handle, links } = streamHarness(src);
  handle({ type: 'items', items: [{ uuid: 'u1', role: 'user', text: 'open src/app.ts' }] });
  const user = links.map((l) => l.text);
  handle({ type: 'turn', open: true });
  handle({ type: 'stream', text: 'It is in src/app', anchor: 'it is in src/app', headCut: false });
  handle({ type: 'stream', text: 'It is in src/app.ts, line 3', anchor: 'it is in src/app', headCut: false });
  const whileStreaming = links.length;
  handle({ type: 'stream', text: null, adopt: 'a1' });
  handle({ type: 'items', items: [{ uuid: 'a1', role: 'assistant', text: 'It is in src/app.ts, line 3' }] });
  assert.ok(cs.items.has('a1'));
  return { whileStreaming, afterwards: links.map((l) => l.text).slice(user.length), user };
}
guarded('streaming: the growing preview is never linked; the finished message is, once, and so is the operator\'s own text',
  (src) => {
    const r = linkRun(src);
    return r.whileStreaming === 1 /* only the operator's bubble */ && r.user.length === 1 && r.user[0] === 'open src/app.ts' && r.afterwards.length === 1 && r.afterwards[0] === 'It is in src/app.ts, line 3';
  },
  (src) => src.replace('if (st.text !== text) { chatRender(st.rec.body, chatSkinStreamMd(text)); st.text = text; }', 'if (st.text !== text) { chatRender(st.rec.body, chatSkinStreamMd(text)); chatLinkPaths(st.rec.body, cs); st.text = text; }'));

guarded('streaming: text growing is ONE provisional bubble, and the finished message takes over that very node — same place, no second bubble, no flash of nothing',
  (src) => {
    const r = streamRun(src);
    return r.provisionals === 1 && r.sameNode && !r.stillProvisional && r.sameSlot && r.answerRows === 1 && /`nextDelay`/.test(r.finalText) && r.renderedOnce && r.ariaHiddenGone;
  },
  (src) => src.replace('  cs.items.set(uuid, st.rec);\n', ''));   // no hand-over: the item makes a NEW node and the preview is left beside it

guarded('streaming: a second preview is never created while the first one is being written',
  (src) => streamRun(src).provisionals === 1,
  (src) => src.replace('  if (!st) {\n    const rec = chatSkinMakeItem', '  if (true) {\n    const rec = chatSkinMakeItem'));

guarded('streaming: a tool that lands while a preview is on screen goes ABOVE it, so the preview stays the last thing and keeps its place under the column',
  (src) => {
    const { cs, handle } = streamHarness(src);
    handle({ type: 'stream', text: 'Let me check the logs and then', anchor: 'let me check the logs and then', headCut: false });
    handle({ type: 'items', items: [{ uuid: 't1', role: 'tool', tool: { id: 't1', name: 'Read', summary: 'a.ts', status: 'running' } }] });
    const kids = (cs.log as Dn).children;
    const prov = kids.findIndex(isProv); const tool = kids.findIndex((c) => c.className.includes('chat-tool'));
    return prov > 0 && tool > 0 && tool < prov && kids.indexOf(cs.workEl) === kids.length - 1 && kids[kids.length - 2] === kids[prov];
  },
  (src) => src.replace(/\(cs\.stream && cs\.stream\.rec\.node\) \|\| (?:cs\.dlg \|\| )?cs\.workEl/, 'cs.workEl'));

guarded('streaming: a preview that was never adopted is dropped when the turn ends or the view resets, and a frozen one waits for its message until then',
  (src) => {
    const { cs, handle } = streamHarness(src);
    const provs = (): number => (cs.log as Dn).children.filter(isProv).length;
    handle({ type: 'stream', text: 'Half of an answer that', anchor: 'half of an answer that', headCut: false });
    handle({ type: 'stream', text: null });                                   // the spinner went away: freeze, do not remove
    const frozen = provs() === 1 && !(cs.log as Dn).children.find(isProv)!.classList.contains('live');
    handle({ type: 'turn', open: false });
    const afterTurn = provs();
    handle({ type: 'stream', text: 'Another answer that', anchor: 'another answer that', headCut: false });
    handle({ type: 'reset' });
    return frozen && afterTurn === 0 && provs() === 0 && cs.stream === null;
  },
  (src) => src.replace("if (!ev.open) { cs.lastSubmitAt = 0; chatSkinStreamDrop(cs); }", 'if (!ev.open) { cs.lastSubmitAt = 0; }'));

guarded('streaming: a different block (its first words are not an extension of the preview\'s) replaces the preview instead of being appended to it',
  (src) => {
    const { cs, handle } = streamHarness(src);
    handle({ type: 'stream', text: 'First block of text here', anchor: 'first block of text here', headCut: false });
    const first = (cs.log as Dn).children.find(isProv);
    handle({ type: 'stream', text: 'Second block starts elsewhere', anchor: 'second block starts elsewhere', headCut: false });
    const provs = (cs.log as Dn).children.filter(isProv);
    // the old preview was NOT the message that came next: it is gone, and the new one is a node of its own (not the old one rewritten)
    return provs.length === 1 && provs[0] !== first && !first!.parent && provs[0].querySelector('.chat-md')!.textContent.startsWith('Second');
  },
  (src) => src.replace("!anchor.startsWith(st.anchor) && !st.anchor.startsWith(anchor)", 'false'));

test('streaming: the preview is dimmer, never coral, has a reduced-motion fallback, and the screen reader hears the finished message once', () => {
  const rules = skinRules(css);
  const all = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.match(all, /\.chat-row\.cs-prov \.chat-md \{ color: color-mix\(in srgb, var\(--ink\) 84%/, 'a step quieter than the message');
  const caret = /\.chat-row\.cs-prov\.live[^{]*::after \{[^}]*\}/.exec(all)?.[0] ?? '';
  assert.match(caret, /background: var\(--st-busy\)/, 'the caret is the busy hue');
  assert.doesNotMatch(caret, /--accent/, 'coral stays on the send button');
  assert.match(all, /@media \(prefers-reduced-motion: reduce\) \{[^@]*\.chat-row\.cs-prov\.live[^{]*::after[^}]*animation: none/, 'reduced motion: no blinking');
  assert.ok(!coralUsers(css).some((s) => /cs-prov|cs-dlg|csd-/.test(s)), `no coral in the preview or the cards: ${coralUsers(css).join(', ')}`);
  assert.ok(rules.length > 10);
  assert.match(fnBody(skin, 'chatSkinStream'), /rec\.node\.setAttribute\('aria-hidden', 'true'\)/, 'hidden from assistive tech while it is only a preview');
  assert.match(fnBody(skin, 'chatSkinStreamAdopt'), /removeAttribute\('aria-hidden'\)/);
});

test('streaming, main: the extractor runs where the transcript is, the preview is sent only while a transcript can replace it, and the adoption goes out BEFORE the item', () => {
  const w = /ipcMain\.handle\('chatSkin:watch'[\s\S]*?\n\}\);/.exec(main)?.[0] ?? '';
  const order = (m: string): boolean => {
    const a = m.indexOf('skin.stream.items(ev.items)');
    const b = m.indexOf('skin.send({ ...rest, sid: sessionId })');
    return a > 0 && b > a;
  };
  assert.ok(order(w), 'the adoption event is computed and sent before the items event');
  assert.equal(order(w.replace('skin.send({ ...rest, sid: sessionId })', 'skin.send({ ...rest, sid: sessionId }); /*moved*/').replace(/if \(ev\.type === 'items'\) \{ const a = skin\.stream\.items\(ev\.items\); if \(a\) skin\.send\(\{ \.\.\.a \}\); \}/, '')), false, 'control: without the adoption step the order check fails');
  const screen = /ipcMain\.on\('chatSkin:screen'[\s\S]*?\n\}\);/.exec(main)?.[0] ?? '';
  assert.match(screen, /if \(!k\.following\) return;/, 'no transcript, no preview: a bubble that nothing can replace is never drawn');
  assert.match(screen, /k\.stream\.screen\(text\)/);
  assert.match(w, /else if \(ev\.type === 'turn'\) \{ if \(ev\.open\) skin\.stream\.begin\(\); else skin\.stream\.end\(\); \}/);
  assert.match(w, /else if \(ev\.type === 'reset'\) skin\.stream\.reset\(\)/);
  assert.match(w, /k\.stream\.reset\(\);/, 'a new watch forgets the old transcript\'s preview');
  assert.match(preload, /\| \{ type: 'stream'; text: string; anchor: string; headCut: boolean \}\n\s+\| \{ type: 'stream'; text: null; adopt\?: string \}/);
});

test('streaming, sampling: a snapshot waits for the repaint to finish, never longer than the old ceiling, and the cost was measured rather than guessed', () => {
  const fn = fnBody(skin, 'chatSkinScreenSoon');
  assert.match(skin, /const CS_SCREEN_QUIET_MS = 40;/);
  assert.match(skin, /const CS_SCREEN_MAX_MS = 150;/, 'the worst case is the old fixed window');
  assert.match(fn, /Math\.min\(CS_SCREEN_QUIET_MS, cs\.screenSince \+ CS_SCREEN_MAX_MS - now\)/);
  assert.match(fn, /cs\.screenTimer = 0; cs\.screenSince = 0;/, 'the window restarts after each snapshot');
  assert.match(fn, /cs\.framing && performance\.now\(\) - cs\.screenSince < CS_SCREEN_MAX_MS \+ CS_FRAME_WAIT_MS/, 'a half-painted frame is waited for, but not for ever');
  assert.match(skin, /const CS_FRAME_WAIT_MS = 250;/);
  assert.match(main, /extractor \$\{avg\(extractMs\)\.toFixed\(2\)\} ms avg/, 'the smoke gate prints what the extractor and the snapshot cost');
});

/** The frame-open tracker and the snapshot timer, run for real against a fake clock: a half-painted frame is waited for, an open frame that never closes is not. */
function frameHarness(src: string = app): { feed: (data: string) => void; soon: () => void; sent: number[]; tick: (ms: number) => void; cs: Record<string, any> } { // eslint-disable-line @typescript-eslint/no-explicit-any
  const from = src.indexOf('function chatSkinFrameState(');
  const to = src.indexOf('/* Called wherever app.js learns, changes or forgets a pane\'s session. */');
  assert.ok(from > 0 && to > from);
  const consts = ['CS_SCREEN_QUIET_MS', 'CS_SCREEN_MAX_MS', 'CS_FRAME_WAIT_MS'].map((n) => new RegExp(`const ${n} = [^\\n]+`).exec(src)![0]).join('\n');
  const sent: number[] = [];
  let now = 0;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let seq = 0;
  const cs: Record<string, any> = { watched: 'sid', screenTimer: 0, screenSince: 0, framing: false }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const p = { chatSkin: cs, view: 'chat', exited: false };
  const make = new Function('performance', 'setTimeout', 'clearTimeout', 'panes', 'window', 'chatSkinScreenText', `${consts}\n${src.slice(from, to)}\nreturn { state: chatSkinFrameState, soon: chatSkinScreenSoon };`) as (...a: unknown[]) => { state: (cs: unknown, d: string) => void; soon: (id: number, p: unknown) => void };
  const api = make({ now: () => now }, (fn: () => void, ms: number) => { const id = ++seq; timers.push({ at: now + ms, fn, id }); return id; },
    (id: number) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); }, new Map([[1, p]]),
    { glassShell: { chatSkinScreen: () => { sent.push(now); } } }, () => 'screen');
  return {
    cs, sent,
    feed: (data) => { api.state(cs, data); api.soon(1, p); },
    soon: () => api.soon(1, p),
    tick: (ms) => { const end = now + ms; for (;;) { timers.sort((a, b) => a.at - b.at); const t0 = timers[0]; if (!t0 || t0.at > end) break; timers.shift(); now = t0.at; t0.fn(); } now = end; },
  };
}
const HIDE = '\x1b[?25l'; const SHOW = '\x1b[?25h';

guarded('a snapshot is not taken between the pieces of one repaint: it waits for the cursor to be shown again, and gives up after a while so a menu that keeps it hidden is still seen',
  (src) => {
    const a = frameHarness(src);
    a.feed(HIDE + 'x'.repeat(1000));                       // the first piece of a long frame: the frame is open
    a.tick(100);
    const heldBack = a.sent.length === 0;
    a.feed('y'.repeat(30) + SHOW);                         // the last piece
    a.tick(60);
    const afterClose = a.sent.length === 1;
    // a menu that hides the cursor and keeps it hidden is still reported, within the ceiling plus the patience
    const b = frameHarness(src);
    b.feed(HIDE + 'menu');
    b.tick(150 + 250 + 40);
    const neverHeldForever = b.sent.length === 1;
    // a complete frame in one piece goes out quickly
    const c = frameHarness(src);
    c.feed(HIDE + 'whole' + SHOW);
    c.tick(60);
    return heldBack && afterClose && neverHeldForever && c.sent.length === 1;
  },
  (src) => src.replace("if (cs.framing && performance.now() - cs.screenSince < CS_SCREEN_MAX_MS + CS_FRAME_WAIT_MS) { cs.screenTimer = setTimeout(fire, 15); return; }", ''));

test('chat-shot fixture: the reply half-written and the same reply after the finished message took its place are shot in dark and light, from neutral, hand-written events', () => {
  const byName = (n: string): FxShot | undefined => fixture.shots.find((s) => s.name === n);
  for (const n of ['stream-half-dark', 'stream-half-light', 'stream-final-dark', 'stream-final-light']) assert.ok(byName(n), `missing shot ${n}`);
  // the half-written reply: ends mid-word, the finished one replaces it by adoption
  const half = fixture.streams['streaming-half'][0] as FxEvent & { text: string; anchor: string };
  assert.equal(half.type, 'stream');
  assert.ok(/[a-z]$/.test(half.text) && !/[.!?:]$/.test(half.text), 'the preview ends mid-sentence');
  const fin = fixture.streams['streaming-final'];
  assert.equal((fin[0] as FxEvent & { adopt?: string }).adopt, 's-a2');
  assert.equal(((fin[1].items ?? [])[0] ?? {}).uuid, 's-a2', 'the adoption names the item that follows it');
  // the harness only feeds the skin: no shot answers anything
  for (const s of fixture.shots) assert.doesNotMatch([s.js].flat().join('\n'), /chatSkinPick\(|ptyWrite/, `${s.name} must not write to the pty`);
});

// ── dialogs as cards: a button per option, one chokepoint for the key, nothing sent without the operator ───────

interface DialogHarness {
  cs: Record<string, any>; p: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  prompt: (ev: Record<string, unknown>) => void; pick: (i: number) => void; key: (e: Record<string, unknown>) => void; sendKey: (key: string) => boolean;
  /** Everything the skin wrote to the pty, with the delay it was scheduled at (0 = at once). */
  writes: Array<{ id: number; data: string; at: number }>; flush: (upToMs?: number) => void; calls: string[];
}
/** The card code (prompt events, the card, its keys, the answer) from the real source, wired to stand-ins. */
function dialogHarness(src: string = app): DialogHarness {
  const from = src.indexOf('const chatSkinCardOn');
  const to = src.indexOf('/* ── actions');
  assert.ok(from > 0 && to > from, 'the dialog block was found');
  const pull = (re: RegExp): string => { const m = re.exec(src); assert.ok(m, `source line ${re} found`); return m[0]; };
  const consts = [pull(/const CS_KEY_GAP_MS = [^\n]+/), pull(/const CS_RETRY_MS = [^\n]+/), pull(/const CHAT_KEY_OK = [^\n]+/), pull(/const CHAT_KEY_CHUNK = [^\n]+/), pull(/const CHAT_PROMPT_KINDS = [^\n]+/)].join('\n');
  const writes: DialogHarness['writes'] = [];
  const calls: string[] = [];
  const timers: Array<{ fn: () => void; ms: number }> = [];
  let clock = 0;
  const log = new Dn('div', 'chat-log'); const workEl = new Dn('div', 'cs-working'); log.append(workEl);
  const input = new Dn('textarea');
  const p: Record<string, any> = { name: 'chat-qa', view: 'chat', exited: false, term: { focus: () => calls.push('term.focus'), blur: () => undefined } }; // eslint-disable-line @typescript-eslint/no-explicit-any
  const cs: Record<string, any> = { id: 7, pane: p, log, workEl, input, promptKind: null, promptHint: '', promptQ: '', promptOpts: null, promptUsed: false, promptTerm: false, promptGen: 0, dlg: null, dlgSig: '', stick: true, stalled: false }; // eslint-disable-line @typescript-eslint/no-explicit-any
  p.chatSkin = cs;
  const panes = new Map([[7, p]]);
  const body = `${consts}
function chatSkinLayout(p) { chatSkinCardPaint(p); calls.push('layout'); }
function chatSkinPlaceholder(p) { p.chatSkin.input.placeholder = p.chatSkin.promptOpts ? 'waiting' : 'message'; }
${src.slice(from, to)}
return { prompt: chatSkinPrompt, pick: chatSkinPick, key: chatSkinCardKey, sendKey: chatSkinSendKey, strip: chatSkinStrip, on: chatSkinCardOn };`;
  const make = new Function('el', 't', 'csIcon', 'panes', 'window', 'document', 'calls', 'setTimeout', 'requestAnimationFrame', 'paneShown', 'active', 'zoneOf', 'markActivity', 'toast', 'repaintTerm',
    'chatSkinWho', 'chatSkinScroll', 'chatSkinRegroup', 'chatSkinPaintAlert', 'chatSkinFocus', 'submitToPty', body) as (...a: unknown[]) => { prompt: (id: number, p: unknown, ev: unknown) => void; pick: (id: number, p: unknown, i: number) => void; key: (cs: unknown, p: unknown, e: unknown) => void; sendKey: (id: number, p: unknown, k: string) => boolean };
  const api = make((tag: string, cls?: string, text?: string) => new Dn(tag, cls, text), (k: string, a?: { name?: string }) => (a && a.name ? `${k}|${a.name}` : k), () => new Dn('span', 'cs-ico'),
    panes, { glassShell: { ptyWrite: (id: number, data: string): void => { writes.push({ id, data, at: clock }); } } }, { hidden: false, get activeElement() { return Dn.active; } }, calls,
    (fn: () => void, ms: number) => { timers.push({ fn, ms: clock + ms }); return timers.length; }, (fn: () => void) => { fn(); return 0; },
    () => true, { term: 7 }, () => 'term', () => undefined, () => undefined, () => undefined,
    (pp: { name?: string }) => pp.name ?? 'Claude', () => undefined, () => undefined, () => undefined, () => undefined,
    (id: number, text: string) => { writes.push({ id, data: text + '\r', at: -1 }); });   // submitToPty: text THEN a CR — what a digit must never get
  return {
    cs, p, writes, calls,
    prompt: (ev) => api.prompt(7, p, { type: 'prompt', ...ev }), pick: (i) => api.pick(7, p, i), key: (e) => api.key(cs, p, { isComposing: false, altKey: false, metaKey: false, ctrlKey: false, preventDefault: () => undefined, ...e }),
    sendKey: (k) => api.sendKey(7, p, k),
    flush: (upToMs = Infinity) => { timers.sort((a, b) => a.ms - b.ms); while (timers.length && timers[0].ms <= upToMs) { const t0 = timers.shift()!; clock = t0.ms; t0.fn(); } },
  };
}
const PERMISSION = { kind: 'permission', hint: 'Do you want to proceed?', question: 'Do you want to proceed?', options: [
  { n: 1, label: 'Yes', selected: true, key: '1' },
  { n: 2, label: "Yes, and don't ask again for npm test commands", selected: false, key: '2' },
  { n: 3, label: 'No, and tell the assistant what to do differently', selected: false, key: '3' }] };
const MENU = { kind: 'select', hint: 'Pick one', question: 'Pick one', options: [
  { n: null, label: 'Keep the current value', selected: true, key: '\r' },
  { n: null, label: 'Use the new value', selected: false, key: '\x1b[B\r' }] };

guarded('a dialog with readable options is a card: a group named for the session, the question as text, one button per option, the cursor\'s option marked, a way to the real terminal',
  (src) => {
    const h = dialogHarness(src);
    h.prompt(PERMISSION);
    const card = h.cs.dlg as Dn | null;
    if (!card) return false;
    const btns = card.querySelectorAll('.csd-opt');
    return card.getAttribute('role') === 'group' && card.getAttribute('aria-label') === 'chat.skin.dlg.label|chat-qa' && btns.length === 3
      && btns.map((b) => b.querySelector('.csd-n')!.textContent).join(',') === '1,2,3' && btns[0].classList.contains('def') && !btns[1].classList.contains('def')
      && card.querySelector('.csd-q')!.textContent === 'Do you want to proceed?' && card.querySelector('.csd-kind')!.textContent === 'chat.skin.dlg.kind.permission|chat-qa'
      && card.querySelector('.csd-link')!.textContent === 'chat.skin.dlg.viewTerminal' && h.writes.length === 0;
  },
  (src) => src.replace("card.setAttribute('role', 'group');", ''));

guarded('a dialog whose options were not read — absent, empty, or with one key that is not a digit, an arrow or Enter — keeps the terminal strip, exactly as before',
  (src) => {
    const cases: Array<Record<string, unknown>> = [
      { kind: 'permission', hint: 'Do you want to proceed?' },
      { kind: 'permission', hint: 'Do you want to proceed?', options: [] },
      { kind: 'permission', hint: 'Do you want to proceed?', options: [{ n: 1, label: 'Yes', selected: true, key: '1' }, { n: 2, label: 'No', selected: false, key: 'rm -rf ~\r' }] },
      { kind: 'permission', hint: 'Do you want to proceed?', options: [{ n: 1, label: 'Yes', selected: true, key: '1' }, { n: 2, label: 42, selected: false, key: '2' }] },
    ];
    return cases.every((c) => {
      const h = dialogHarness(src);
      h.prompt(c);
      return h.cs.dlg === null && h.cs.promptOpts === null && h.cs.promptKind === 'permission' && h.writes.length === 0
        && (h.cs.log as Dn).children.every((n) => !n.classList.contains('cs-dlg'));
    });
  },
  (src) => src.replace("typeof o.key !== 'string' || !CHAT_KEY_OK.test(o.key)) return null;", "typeof o.key !== 'string') return null;"));

test('the layout decides strip or card from ONE rule: a card is drawn, the strip is not, and the other way round', () => {
  const h = dialogHarness();
  h.prompt(PERMISSION);
  assert.equal(h.cs.promptOpts.length, 3);
  assert.ok(h.cs.dlg, 'a card');
  const strip = (): boolean => new Function('cs', `${/const chatSkinCardOn = [^\n]+\nconst chatSkinStrip = [^\n]+/.exec(app)![0]}\nreturn chatSkinStrip(cs);`)(h.cs) as boolean;
  assert.equal(strip(), false, 'a card: the xterm stays hidden');
  h.cs.promptTerm = true;
  assert.equal(strip(), true, '"View in the terminal" brings the real strip');
  h.cs.promptOpts = null; h.cs.promptTerm = false;
  assert.equal(strip(), true, 'no options: the strip');
  h.cs.promptKind = null;
  assert.equal(strip(), false, 'no dialog: neither');
  assert.match(fnBody(skin, 'chatSkinLayout'), /classList\.toggle\('cs-strip', on && chatSkinStrip\(cs\)\)/);
  assert.match(fnBody(skin, 'chatSkinPaintAlert'), /chatSkinCardOn\(cs\) \? '' :/, 'a card is its own notice');
});

guarded('a click sends exactly the option\'s key — one write for a digit, one write per piece for arrows and Enter — through the key chokepoint, never as text followed by a CR',
  (src) => {
    const h = dialogHarness(src);
    h.prompt(PERMISSION);
    h.pick(2);                                   // "No, and tell…": key '3'
    h.flush();
    const digit = h.writes.length === 1 && h.writes[0].data === '3' && h.writes[0].id === 7;
    const h2 = dialogHarness(src);
    h2.prompt(MENU);
    h2.pick(1);                                  // an unnumbered menu: arrow down, then Enter, as two writes a moment apart
    h2.flush();
    const arrows = h2.writes.length === 2 && h2.writes[0].data === '\x1b[B' && h2.writes[1].data === '\r' && h2.writes[1].at > h2.writes[0].at;
    return digit && arrows && [...h.writes, ...h2.writes].every((w) => /^(?:\x1b\[[AB]|\r|[0-9])$/.test(w.data));
  },
  (src) => src.replace('  chatSkinSendKey(id, p, o.key);', '  submitToPty(id, o.key);'));

guarded('nothing but a digit, an arrow or Enter can ever come out of the key path, whatever a parser or a hostile screen put in an option',
  (src) => {
    const h = dialogHarness(src);
    const bad = ['rm -rf ~', '1\rrm', '\x1b', '\x1b[2J', 'y', '', '1 ', '\x03'];
    const refused = bad.every((k) => h.sendKey(k) === false);
    const ok = h.sendKey('2') === true && h.sendKey('\x1b[A\r') === true;
    h.flush();
    return refused && ok && h.writes.map((w) => w.data).join('|') === '2|\x1b[A|\r';
  },
  (src) => src.replace("if (typeof key !== 'string' || !CHAT_KEY_OK.test(key)) return false;", "if (typeof key !== 'string') return false;"));

guarded('a double click answers once: the card is used and disabled until the next dialog event; a moved cursor keeps it used but adopts the new keys; a new dialog is a fresh card',
  (src) => {
    const h = dialogHarness(src);
    h.prompt(MENU);
    h.pick(0); h.pick(0); h.pick(1);
    h.flush(1000);
    const once = h.writes.length === 1 && h.writes[0].data === '\r';
    const used = h.cs.promptUsed === true && (h.cs.dlg as Dn).querySelectorAll('.csd-opt').every((b) => b.disabled);
    // the cursor moved in the terminal: the SAME dialog, new keys and a new default — still used, nothing re-enabled, nothing sent
    h.prompt({ ...MENU, refresh: true, options: [{ ...MENU.options[0], selected: false, key: '\x1b[A\r' }, { ...MENU.options[1], selected: true, key: '\r' }] });
    const refreshed = h.cs.promptUsed === true && h.cs.promptOpts[1].key === '\r' && (h.cs.dlg as Dn).querySelectorAll('.csd-opt')[1].classList.contains('def') && h.writes.length === 1;
    // the NEXT dialog (a different question) is a new, enabled card
    h.prompt({ ...PERMISSION });
    const fresh = h.cs.promptUsed === false && (h.cs.dlg as Dn).querySelectorAll('.csd-opt').every((b) => !b.disabled) && (h.cs.dlg as Dn).querySelectorAll('.csd-opt').length === 3;
    return once && used && refreshed && fresh;
  },
  (src) => src.replace('  cs.promptUsed = true;\n  const gen', '  const gen'));

test('a used card whose dialog is still up after a while is re-armed, and one that was answered is not', () => {
  const h = dialogHarness();
  h.prompt(PERMISSION);
  h.pick(0);
  h.flush(2000);
  assert.equal(h.cs.promptUsed, true, 'still used a moment later');
  h.flush(7000);
  assert.equal(h.cs.promptUsed, false, 'the key never landed: the operator can answer again');
  const g = dialogHarness();
  g.prompt(PERMISSION);
  g.pick(0);
  g.prompt({ kind: null });                      // the dialog went away: answered
  g.flush(7000);
  assert.equal(g.cs.dlg, null);
  assert.equal(g.cs.promptUsed, false);
  assert.equal(g.writes.length, 1, 'and nothing was sent a second time');
});

guarded('the card writes NOTHING on its own: drawing it, refreshing its keys, focusing it, a quiet period and the dialog going away send no key',
  (src) => {
    const h = dialogHarness(src);
    h.prompt(PERMISSION);
    h.prompt({ ...PERMISSION, refresh: true });
    h.prompt({ ...MENU });
    h.prompt({ ...MENU, refresh: true });
    h.key({ key: 'ArrowDown' });
    h.key({ key: 'Tab' });
    h.flush();
    h.prompt({ kind: null });
    h.flush();
    return h.writes.length === 0;
  },
  (src) => src.replace("  chatSkinCardSync(cs);\n}\nfunction chatSkinCardBuild", "  chatSkinCardSync(cs);\n  if (cs.promptOpts.some((o) => o.selected) && !cs.promptUsed) chatSkinPick(cs.id, p, cs.promptOpts.findIndex((o) => o.selected));\n}\nfunction chatSkinCardBuild"));

guarded('the keyboard: a digit presses that option (an unnumbered menu counts 1, 2, 3 from the top), arrows move focus, and a chord is left alone',
  (src) => {
    const h = dialogHarness(src);
    h.prompt(PERMISSION);
    h.key({ key: '2' });
    h.flush();
    const digit = h.writes.length === 1 && h.writes[0].data === '2';
    const m = dialogHarness(src);
    m.prompt(MENU);
    m.key({ key: '9' });                        // no option 9
    m.key({ key: '2', ctrlKey: true });         // a chord is not the operator choosing
    m.flush();
    const quiet = m.writes.length === 0;
    m.key({ key: '2' });
    m.flush();
    const byPosition = m.writes.map((w) => w.data).join('|') === '\x1b[B|\r';
    const f = dialogHarness(src);
    f.prompt(PERMISSION);
    const btns = (f.cs.dlg as Dn).querySelectorAll('.csd-opt');
    btns[0].focus();
    f.key({ key: 'ArrowDown' });
    const down = Dn.active === btns[1];
    f.key({ key: 'ArrowUp' }); f.key({ key: 'ArrowUp' });
    const wrap = Dn.active === btns[2];
    return digit && quiet && byPosition && down && wrap && f.writes.length === 0;
  },
  (src) => src.replace('const b = btns.find((x) => x.dataset.num === e.key);', 'const b = btns.find((x) => x.dataset.num === "0");'));

test('an option that asks for typing only gets its key, and the live terminal comes forward so the operator can type', () => {
  const h = dialogHarness();
  h.prompt({ kind: 'question', hint: 'Which?', question: 'Which?', options: [
    { n: null, label: 'The first', selected: true, key: '\r' },
    { n: null, label: 'Type something.', selected: false, key: '\x1b[B', freeText: true }] });
  h.pick(1);
  h.flush();
  assert.deepEqual(h.writes.map((w) => w.data), ['\x1b[B'], 'the arrow only: no Enter, which would submit an empty answer');
  assert.equal(h.cs.promptTerm, true);
  assert.ok(h.calls.includes('term.focus'), 'the xterm takes the focus');
  assert.equal(h.cs.dlg, null, 'the card steps aside for the strip');
  // control: an ordinary option does not bring the terminal
  const g = dialogHarness();
  g.prompt(MENU); g.pick(0);
  assert.equal(g.cs.promptTerm, false);
});

test('"View in the terminal" shows the strip without answering anything, and the way back restores the buttons', () => {
  const h = dialogHarness();
  h.prompt(PERMISSION);
  const link = (h.cs.dlg as Dn).querySelector('.csd-link')!;
  link.click();
  assert.equal(h.cs.promptTerm, true);
  assert.equal(h.writes.length, 0, 'looking is not answering');
  assert.equal(h.cs.dlg, null);
  assert.equal(h.cs.promptOpts.length, 3, 'the options are kept for the way back');
  assert.match(fnBody(skin, 'chatSkinPaintAlert'), /cs\.alertBack\.hidden = !\(cs\.promptKind && cs\.promptOpts && cs\.promptTerm\)/);
  assert.match(skin, /alertBack\.addEventListener\('click', \(\) => \{ cs\.promptTerm = false;/);
});

guarded('only chatSkinPick answers a dialog, and only chatSkinSendKey writes its key: no other call site, no timer, no event handler',
  (src) => {
    const s = slice(src);
    const callsOfSend = [...s.matchAll(/chatSkinSendKey\(/g)].length;      // the definition + the one call
    const callsOfPick = [...s.matchAll(/chatSkinPick\(/g)].map((m) => m.index as number);
    const insidePick = fnBody(s, 'chatSkinPick');
    const pickCallers = [fnBody(s, 'chatSkinCardBuild'), fnBody(s, 'chatSkinCardKey')];
    return callsOfSend === 2 && /chatSkinSendKey\(id, p, o\.key\)/.test(insidePick)
      && pickCallers.every((b) => /chatSkinPick\(/.test(b)) && callsOfPick.length === 3   // the definition + the click handler + the digit key
      && !/chatSkinPick\(/.test(fnBody(s, 'chatSkinPrompt')) && !/chatSkinPick\(/.test(fnBody(s, 'chatSkinCardPaint')) && !/chatSkinPick\(/.test(fnBody(s, 'chatSkinHandleEvent'));
  },
  (src) => src.replace('function chatSkinPrompt(id, p, ev) {\n  const cs = p.chatSkin;', 'function chatSkinPrompt(id, p, ev) {\n  const cs = p.chatSkin;\n  if (ev.auto) chatSkinPick(id, p, 0);'));

test('dialog cards: every string is a locale key with the session\'s name in it where a name appears, in en, es and pt-br', () => {
  const kinds = ['permission', 'trust', 'select', 'question', 'model', 'other'];
  const keys = [...skin.matchAll(/\bt\('(chat\.skin\.dlg\.[\w.]+)'/g)].map((m) => m[1]).filter((k) => !k.endsWith('.'));
  for (const k of kinds) keys.push(`chat.skin.dlg.kind.${k}`);
  keys.push('chat.skin.needsYouHere');
  assert.ok(new Set(keys).size >= 12, `found ${new Set(keys).size} keys`);
  for (const l of Object.keys(loc)) for (const k of new Set(keys)) assert.ok(typeof loc[l][k] === 'string' && loc[l][k].length > 0, `${l}.json lacks ${k}`);
  for (const l of Object.keys(loc)) for (const k of ['chat.skin.dlg.label', 'chat.skin.needsYouHere', ...kinds.map((x) => `chat.skin.dlg.kind.${x}`)]) {
    assert.match(loc[l][k], /\{name\}/, `${l} ${k} names the session`);
    assert.doesNotMatch(loc[l][k], /Claude/, `${l} ${k} must not hardcode the product name`);
  }
  assert.match(fnBody(skin, 'chatSkinCardBuild'), /t\('chat\.skin\.dlg\.label', \{ name: who \}\)/);
  assert.match(fnBody(skin, 'chatSkinCardBuild'), /const who = chatSkinWho\(p\)/);
  // control: a locale that dropped the name is caught by the same pattern
  assert.doesNotMatch('Asks for permission', /\{name\}/);
});

test('the dialog card is the house component set: blue (--st-input), a neutral default, no coral, a hover and a focus ring, and nothing minted in the card\'s own rules', () => {
  const all = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const card = /\.cs-dlg \{[^}]*\}/.exec(all)?.[0] ?? '';
  assert.match(card, /--sc: var\(--st-input\)/);
  assert.doesNotMatch(card, /--accent/);
  for (const sel of ['.csd-opt', '.csd-opt.def', '.csd-opt:hover:not(:disabled)', '.csd-opt:disabled', '.csd-opt:focus-visible', '.csd-link']) {
    const r = new RegExp(`${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{[^}]*\\}`).exec(all)?.[0] ?? '';
    assert.ok(r, `${sel} is styled`);
    assert.doesNotMatch(r, /--accent|#[0-9a-fA-F]{3,8}\b/, `${sel}: no coral, no hex`);
  }
  assert.match(all, /\.csd-opt:focus-visible \{ outline: 2px solid var\(--chat-focus\)/);
  assert.match(all, /@media \(prefers-reduced-motion: reduce\) \{ \.csd-opt \{ transition: none; \} \}/);
});

test('main forwards what the parser read of a dialog — the question and the options with their keys — bounded, and marks a moved cursor as a refresh, not a new dialog', () => {
  const w = /ipcMain\.handle\('chatSkin:watch'[\s\S]*?\n\}\);/.exec(main)?.[0] ?? '';
  const wire = /function promptWire\([\s\S]*?\n\}/.exec(main)?.[0] ?? '';
  assert.match(w, /onChange: \(kind, hint, prompt\) => send\(\{ type: 'prompt', kind, \.\.\.\(hint \? \{ hint \} : \{\}\), \.\.\.promptWire\(prompt\) \}\)/);
  assert.match(w, /onRefresh: \(prompt\) => send\(\{ type: 'prompt', kind: prompt\.kind,[^\n]*\.\.\.promptWire\(prompt\), refresh: true \}\)/);
  assert.match(wire, /\.slice\(0, 12\)/, 'at most a dozen rows');
  assert.match(wire, /label: String\(o\.label\)\.slice\(0, 200\)/);
  assert.match(wire, /prompt\.question\.slice\(0, 300\)/);
  assert.match(wire, /key: o\.key/, 'the key is the parser\'s, passed through untouched');
  assert.doesNotMatch(wire, /key: [^o]|o\.key\s*[+=]/, 'main never edits or invents a key');
  // a `null` dialog carries no options at all (nothing to draw once it is gone)
  assert.match(wire, /if \(!prompt\) return \{\}/);
  assert.match(preload, /\| \{ type: 'prompt'; kind: TuiPromptKind \| null; hint\?: string; question\?: string; options\?: TuiOption\[\]; refresh\?: boolean \}/);
});

test('chat-shot fixture: the permission card, the menu cards, the used card, the narrow card and the strip-with-a-way-back are shot in dark and light, from neutral, hand-written events', () => {
  const byName = (n: string): FxShot | undefined => fixture.shots.find((s) => s.name === n);
  for (const n of ['dialog-permission-dark', 'dialog-permission-light', 'dialog-menu-dark', 'dialog-menu-light',
    'dialog-question-dark', 'dialog-question-light', 'dialog-permission-used-dark', 'dialog-terminal-dark', 'dialog-narrow-dark', 'dialog-narrow-light']) assert.ok(byName(n), `missing shot ${n}`);
  // every dialog event carries options whose keys are what the renderer will accept (a digit, an arrow, Enter)
  for (const n of ['permission-card', 'menu-card', 'question-card']) {
    const pr = fixture.streams[n].find((e) => e.type === 'prompt') as FxEvent & { options: Array<{ label: string; key: string; selected: boolean }> };
    assert.ok(pr && pr.options.length >= 3, `${n} has its options`);
    assert.equal(pr.options.filter((o) => o.selected).length, 1, `${n}: one default`);
    for (const o of pr.options) assert.match(o.key, /^(?:\x1b\[[AB]|\r|[0-9])+$/, `${n}: ${o.label} has a key the card accepts`);
  }
  assert.ok(fixture.streams['question-card'].some((e) => e.type === 'prompt' && (e.options as Array<{ freeText?: boolean }>).some((o) => o.freeText)), 'a typing option is shown too');
  // the harness only feeds the skin: no shot clicks an option (that would write to the cat behind the pane)
  for (const s of fixture.shots) assert.doesNotMatch([s.js].flat().join('\n'), /csd-opt[^\n]*click\(|chatSkinPick\(|ptyWrite/, `${s.name} must not answer a dialog`);
  assert.match([byName('dialog-terminal-dark')?.js].flat().join('\n'), /\.csd-link'\)\.click\(\)/);
});


// ── a run of tool calls folds into ONE row ─────────────────────────────────────────────────────────────────

type ToolStatus = 'running' | 'ok' | 'error';
const toolItem = (uuid: string, name = 'Bash', status: ToolStatus = 'ok', summary = ''): Record<string, unknown> => ({ uuid, role: 'tool', tool: { id: uuid, name, summary, status } });
const textItem = (uuid: string, role: 'assistant' | 'user' = 'assistant', text = 'on it'): Record<string, unknown> => ({ uuid, role, text });
const isGroup = (n: Dn): boolean => n.className.split(/\s+/).includes('chat-tg');
const groupsOf = (cs: StreamHarness['cs']): Dn[] => (cs.log as Dn).children.filter(isGroup);
const soloTools = (cs: StreamHarness['cs']): Dn[] => (cs.log as Dn).children.filter((c) => c.className.split(/\s+/).includes('chat-tool'));
const inBody = (g: Dn): Dn[] => g.querySelector('.cg-body')?.children ?? [];
const classes = (n: Dn): string[] => n.className.split(/\s+/).filter(Boolean);
/** The two pure functions, evaluated from a given source: they take plain data, so a test can run them for real. */
function loadRuns(src: string): { runs: (items: Array<{ tool?: boolean; hidden?: boolean }>) => number[][]; summary: (run: Array<{ name: string; summary?: string; status: string }>) => { total: number; counts: Array<{ name: string; n: number }>; running: number; failed: number; ok: number; status: string; current: { name: string; summary: string } | null } } {
  const s = slice(src);
  return new Function(`${fnBody(s, 'chatToolRuns')}\n${fnBody(s, 'chatToolSummary')}\nreturn { runs: chatToolRuns, summary: chatToolSummary };`)() as ReturnType<typeof loadRuns>;
}
const T = { tool: true }; const X = {}; const H = { hidden: true };

guarded('runs, run for real: N tool calls in a row are ONE run, and a single one is a run of one',
  (src) => {
    const { runs } = loadRuns(src);
    const a = runs([T, T, T, T, T]);
    const b = runs([X, T, X]);
    return a.length === 1 && a[0].join() === '0,1,2,3,4' && b.length === 1 && b[0].join() === '1' && runs([X, X]).length === 0 && runs([]).length === 0;
  },
  (src) => src.replace('if (it.tool) { if (!cur) cur = []; cur.push(i); continue; }', 'if (it.tool) { cur = [i]; runs.push(cur); continue; }'));   // every call its own run

guarded('runs, run for real: a visible row between two calls makes two runs; a hidden one does not',
  (src) => {
    const { runs } = loadRuns(src);
    const text = runs([T, T, X, T, T, T]);
    const hidden = runs([T, H, T, H, H, T]);
    return text.length === 2 && text[0].join() === '0,1' && text[1].join() === '3,4,5' && hidden.length === 1 && hidden[0].join() === '0,2,5';
  },
  (src) => src.replace('    if (it.hidden) continue;\n', ''));   // a hidden row cuts the run, like any other

guarded('the summary, run for real: it counts by name in order of first appearance, and says the call in progress',
  (src) => {
    const { summary } = loadRuns(src);
    const call = (name: string, status = 'ok', s = ''): { name: string; summary: string; status: string } => ({ name, status, summary: s });
    const r = summary([call('Bash'), call('Read'), call('Read'), call('Bash'), call('Read'), call('Bash'), call('Read')]);
    const live = summary([call('Read'), call('Bash', 'running', 'npm test'), call('Grep', 'running', 'TODO src'), call('Read')]);
    return r.total === 7 && r.counts.map((c) => `${c.name} x${c.n}`).join() === 'Bash x3,Read x4' && r.status === 'ok' && r.current === null
      && live.current?.name === 'Grep' && live.current.summary === 'TODO src' && live.running === 2 && summary([call('  ')]).counts[0].name === '?';
  },
  (src) => src.replace('if (!at.has(name)) { at.set(name, counts.length); counts.push({ name, n: 0 }); }', 'if (!at.has(name)) { at.set(name, 0); counts.unshift({ name, n: 0 }); }'));   // newest name first: the line reorders itself as calls land

guarded('the summary, run for real: running wins while any call runs, then any failure, then ok — and the failures are counted exactly',
  (src) => {
    const { summary } = loadRuns(src);
    const mk = (...st: string[]): Array<{ name: string; status: string }> => st.map((status, i) => ({ name: 'T' + i, status }));
    const allOk = summary(mk('ok', 'ok', 'ok'));
    const some = summary(mk('ok', 'error', 'ok'));
    const two = summary(mk('error', 'ok', 'error', 'error'));
    const mixed = summary(mk('error', 'running', 'ok'));
    return allOk.status === 'ok' && allOk.failed === 0 && some.status === 'error' && some.failed === 1 && two.failed === 3 && two.ok === 1
      && mixed.status === 'running' && mixed.failed === 1 && mixed.running === 1;
  },
  (src) => src.replace("status: running ? 'running' : failed ? 'error' : 'ok'", "status: failed ? 'error' : running ? 'running' : 'ok'"));

guarded('the column folds N calls in a row into one group row holding them in order; the rows keep their nodes',
  (src) => {
    const { cs, handle } = streamHarness(src);
    handle({ type: 'items', items: [toolItem('t1'), toolItem('t2', 'Read'), toolItem('t3'), toolItem('t4', 'Grep'), toolItem('t5')] });
    const g = groupsOf(cs);
    const kids = (cs.log as Dn).children;
    return g.length === 1 && soloTools(cs).length === 0 && inBody(g[0]).length === 5 && inBody(g[0]).every((n, i) => n === cs.items.get('t' + (i + 1)).node)
      && kids.indexOf(g[0]) === 1 && kids[0] === cs.stateEl && kids[kids.length - 1] === cs.workEl;
  },
  (src) => src.replace('if (r.length > 1) spans.set', 'if (r.length > 99) spans.set'));   // nothing folds

guarded('a message between two calls makes two groups with the message between them; a hidden row inside a run stays inside it',
  (src) => {
    const { cs, handle } = streamHarness(src);
    handle({ type: 'items', items: [toolItem('t1'), toolItem('t2'), textItem('a1', 'assistant', 'Found it.'), toolItem('t3'), toolItem('t4')] });
    const g = groupsOf(cs);
    const kids = (cs.log as Dn).children;
    const twoGroups = g.length === 2 && kids.indexOf(g[0]) < kids.indexOf(cs.items.get('a1').node) && kids.indexOf(cs.items.get('a1').node) < kids.indexOf(g[1]);
    // an assistant message that was only tool calls: hidden, and between two calls
    const h = streamHarness(src);
    h.handle({ type: 'items', items: [toolItem('t1'), textItem('a0', 'assistant', ''), toolItem('t2'), textItem('a9', 'assistant', ''), toolItem('t3')] });
    const hg = groupsOf(h.cs);
    const order = hg.length === 1 ? inBody(hg[0]).map((n) => n === h.cs.items.get('t1').node ? 't1' : n === h.cs.items.get('t2').node ? 't2' : n === h.cs.items.get('t3').node ? 't3' : n === h.cs.items.get('a0').node ? 'a0' : 'a9') : [];
    return twoGroups && inBody(g[0]).length === 2 && order.join() === 't1,a0,t2,a9,t3';
  },
  (src) => src.replace('    if (it.hidden) continue;\n', ''));

guarded('a run of ONE call is a plain row, not a group; the same call becomes a group when the next one lands',
  (src) => {
    const { cs, handle } = streamHarness(src);
    handle({ type: 'items', items: [textItem('u1', 'user', 'run it'), toolItem('t1'), textItem('a1')] });
    const alone = groupsOf(cs).length === 0 && soloTools(cs).length === 1;
    handle({ type: 'items', items: [toolItem('t2')] });   // lands after the message: still a run of one
    const stillAlone = groupsOf(cs).length === 0 && soloTools(cs).length === 2;
    handle({ type: 'items', items: [toolItem('t3')] });
    return alone && stillAlone && groupsOf(cs).length === 1 && inBody(groupsOf(cs)[0]).length === 2 && soloTools(cs).length === 1;
  },
  (src) => src.replace('if (r.length > 1) spans.set', 'if (r.length > 0) spans.set'));   // a lone call is a group too

guarded('the folded row is a button with aria-expanded and aria-controls, starts folded, and says its state in words for a screen reader',
  (src) => {
    const { cs, handle } = streamHarness(src);
    handle({ type: 'items', items: [toolItem('t1', 'Bash', 'running', 'npm test'), toolItem('t2', 'Read', 'ok')] });
    const g = groupsOf(cs)[0];
    const head = g.querySelector('.cg-head'); const body = g.querySelector('.cg-body');
    const sr = g.querySelector('.cg-state')?.querySelector('.cs-sr');
    return !!head && !!body && head.tag === 'button' && (head as unknown as { type: string }).type === 'button' && head.attrs['aria-expanded'] === 'false' && body.hidden === true
      && !!body.id && head.attrs['aria-controls'] === body.id && !!sr && sr.textContent === 'running' && !g.classList.contains('open');
  },
  (src) => src.replace("  head.setAttribute('aria-controls', body.id);\n  node.append(head, body);", "  node.append(head, body);"));

guarded('the group row says what is running now (name and argument), and the state in the mark: spinner, tick, or cross with the exact number that failed',
  (src) => {
    const run = (lang: 'en' | 'es' | 'pt-br'): { live: string; list: string; count: string; cls: string[]; fail: string; hiddenFail: boolean; sr: string; spin: boolean }[] => {
      const { cs, handle } = streamHarness(src, lang);
      const snap = (): { live: string; list: string; count: string; cls: string[]; fail: string; hiddenFail: boolean; sr: string; spin: boolean } => {
        const g = groupsOf(cs)[0];
        return {
          live: g.querySelector('.cg-ln')!.textContent + '|' + g.querySelector('.cg-la')!.textContent, list: g.querySelector('.cg-list')!.textContent, count: g.querySelector('.cg-n')!.textContent,
          cls: classes(g), fail: g.querySelector('.cg-fail')!.textContent, hiddenFail: g.querySelector('.cg-fail')!.hidden, sr: g.querySelector('.cg-state')!.querySelector('.cs-sr')!.textContent,
          spin: !!g.querySelector('.cg-state')!.querySelector('.ct-spin'),
        };
      };
      const out = [];
      handle({ type: 'items', items: [toolItem('t1', 'Bash', 'ok'), toolItem('t2', 'Read', 'ok'), toolItem('t3', 'Bash', 'running', 'npm test --watch')] });
      out.push(snap());
      handle({ type: 'items', items: [toolItem('t3', 'Bash', 'ok')] });
      out.push(snap());
      handle({ type: 'items', items: [toolItem('t2', 'Read', 'error')] });
      out.push(snap());
      handle({ type: 'items', items: [toolItem('t1', 'Bash', 'error')] });
      out.push(snap());
      return out;
    };
    const en = run('en'); const es = run('es'); const pt = run('pt-br');
    const [live, done, one, two] = en;
    return live.cls.includes('running') && live.spin && live.live === 'Bash|npm test --watch' && live.count === '3 actions' && live.list === 'Bash ×2, Read' && live.hiddenFail && live.sr === 'running'
      && done.cls.includes('ok') && !done.spin && done.sr === 'done' && done.hiddenFail && !done.cls.includes('running')
      && one.cls.includes('error') && !one.cls.includes('ok') && one.fail === '1 failed' && !one.hiddenFail && one.sr === '1 failed'
      && two.fail === '2 failed' && two.sr === '2 failed'
      // plurals are different words in Spanish and Portuguese
      && es[2].fail === '1 falló' && es[3].fail === '2 fallaron' && pt[2].fail === '1 falhou' && pt[3].fail === '2 falharam' && es[0].count === '3 acciones' && pt[0].count === '3 ações';
  },
  (src) => src.replace("t(sum.failed === 1 ? 'chat.skin.tg.failed.one' : 'chat.skin.tg.failed.other', { n: sum.failed })", "t('chat.skin.tg.failed.other', { n: sum.failed })"));

guarded('a folded row shows no call in progress once nothing runs: the counts replace it',
  (src) => {
    const { cs, handle } = streamHarness(src);
    handle({ type: 'items', items: [toolItem('t1', 'Bash', 'running', 'sleep 9'), toolItem('t2', 'Bash', 'ok')] });
    const g = groupsOf(cs)[0];
    const running = g.querySelector('.cg-la')!.textContent === 'sleep 9';
    handle({ type: 'items', items: [toolItem('t1', 'Bash', 'ok', 'sleep 9')] });
    return running && g.querySelector('.cg-ln')!.textContent === '' && g.querySelector('.cg-la')!.textContent === '' && g.querySelector('.cg-list')!.textContent === 'Bash ×2';
  },
  (src) => src.replace("g.liveName.textContent = cur ? cur.name : '';", "g.liveName.textContent = cur ? cur.name : g.liveName.textContent;"));   // the last action lingers after it finished

guarded('the unfolded state survives a call landing in the group, a status change and a repaint: the node is the same and stays open',
  (src) => {
    const { cs, handle } = streamHarness(src);
    handle({ type: 'items', items: [toolItem('t1', 'Bash', 'ok'), toolItem('t2', 'Read', 'running', 'a.ts')] });
    const g = groupsOf(cs)[0];
    g.querySelector('.cg-head')!.click();
    const openNow = g.querySelector('.cg-head')!.attrs['aria-expanded'] === 'true' && g.querySelector('.cg-body')!.hidden === false && g.classList.contains('open');
    const row = cs.items.get('t1').node as Dn; row.classList.add('open');   // a row inside, opened by the operator
    handle({ type: 'items', items: [toolItem('t3', 'Grep', 'running', 'x')] });                    // the run grows
    handle({ type: 'items', items: [toolItem('t2', 'Read', 'ok', 'a.ts'), toolItem('t3', 'Grep', 'ok', 'x')] });   // statuses move
    handle({ type: 'turn', open: false });
    const same = groupsOf(cs).length === 1 && groupsOf(cs)[0] === g && inBody(g).length === 3;
    const stillOpen = g.querySelector('.cg-head')!.attrs['aria-expanded'] === 'true' && g.querySelector('.cg-body')!.hidden === false && g.classList.contains('open');
    return openNow && same && stillOpen && row.classList.contains('open') && inBody(g)[0] === row;
  },
  (src) => src.replace('    let g = groups.get(key);\n', '    let g = null;\n'));   // a new node on every batch: whatever was open is gone

guarded('a group the operator folded back stays folded when more arrive, and a new run starts folded',
  (src) => {
    const { cs, handle } = streamHarness(src);
    handle({ type: 'items', items: [toolItem('t1'), toolItem('t2')] });
    const g = groupsOf(cs)[0];
    const head = g.querySelector('.cg-head')!;
    const startsFolded = head.attrs['aria-expanded'] === 'false';
    head.click(); head.click();
    handle({ type: 'items', items: [toolItem('t3')] });
    const folded = groupsOf(cs)[0] === g && head.attrs['aria-expanded'] === 'false' && g.querySelector('.cg-body')!.hidden;
    handle({ type: 'items', items: [textItem('a1'), toolItem('t4'), toolItem('t5')] });
    const second = groupsOf(cs)[1];
    return startsFolded && !!folded && groupsOf(cs).length === 2 && second.querySelector('.cg-head')!.attrs['aria-expanded'] === 'false';
  },
  (src) => src.replace('chatSkinGroupOpen(g, !g.open);', 'chatSkinGroupOpen(g, true);'));   // the second click does not fold it back

guarded('a run that splits and joins again (a hidden row shows a message, then goes) comes back with the state the operator left it in',
  (src) => {
    const { cs, handle } = streamHarness(src);
    handle({ type: 'items', items: [toolItem('t1'), textItem('a0', 'assistant', ''), toolItem('t2'), toolItem('t3')] });
    groupsOf(cs)[0].querySelector('.cg-head')!.click();
    handle({ type: 'items', items: [textItem('a0', 'assistant', 'wait')] });   // the row has something to say: the run is cut in two
    const split = groupsOf(cs).length === 1 && soloTools(cs).length === 1 && inBody(groupsOf(cs)[0]).length === 2 && groupsOf(cs)[0].querySelector('.cg-head')!.attrs['aria-expanded'] === 'false';   // t1 is alone now; the new run starts folded
    handle({ type: 'items', items: [textItem('a0', 'assistant', '')] });      // and it does not after all
    const g = groupsOf(cs);
    return split && g.length === 1 && inBody(g[0]).length === 4 && g[0].querySelector('.cg-head')!.attrs['aria-expanded'] === 'true';
  },
  (src) => src.replace('    cs.groupOpen.set(key, g.open);\n', ''));   // the choice lives only on the node, which is gone

guarded('a row the operator had open does not vanish when its run becomes a group: that group starts unfolded',
  (src) => {
    const { cs, handle } = streamHarness(src);
    handle({ type: 'items', items: [toolItem('t1')] });
    (cs.items.get('t1').node as Dn).classList.add('open');
    handle({ type: 'items', items: [toolItem('t2')] });
    const g = groupsOf(cs)[0];
    const calm = streamHarness(src);
    calm.handle({ type: 'items', items: [toolItem('t1')] });
    calm.handle({ type: 'items', items: [toolItem('t2')] });
    return !!g && g.classList.contains('open') && g.querySelector('.cg-body')!.hidden === false && groupsOf(calm.cs)[0].querySelector('.cg-body')!.hidden === true;
  },
  (src) => src.replace("members.some((m) => m.classList.contains('open') || (m.csRec && opened.get(m.csRec.uuid) === true))", 'false'));

/** streamHarness plus what chatSkinPrepend reads off the log: a style bag, the scroll numbers, and the state line's next sibling. */
function prependHarness(src: string): StreamHarness {
  const h = streamHarness(src);
  const log = h.cs.log as Dn; const stateEl = h.cs.stateEl as Dn;
  Object.assign(log, { style: {}, scrollTop: 0, scrollHeight: 0 });
  Object.defineProperty(stateEl, 'nextSibling', { get: () => log.children[log.children.indexOf(stateEl) + 1] });
  return h;
}
guarded('older calls that join a run from above (the tail window cut it) keep the run unfolded if the operator had it unfolded, folded if not, and lose no row',
  (src) => {
    const open = prependHarness(src);
    open.handle({ type: 'items', items: [toolItem('t3'), toolItem('t4'), textItem('a1')] });   // the window starts inside the run: two calls on show
    groupsOf(open.cs)[0].querySelector('.cg-head')!.click();
    open.handle({ type: 'earlier', items: [toolItem('t1'), toolItem('t2')], more: false });
    const g = groupsOf(open.cs);
    const nodes = ['t1', 't2', 't3', 't4'].map((u) => open.cs.items.get(u).node);
    const joined = g.length === 1 && soloTools(open.cs).length === 0 && inBody(g[0]).length === 4 && inBody(g[0]).every((n, i) => n === nodes[i]);
    const kept = g[0].querySelector('.cg-head')!.attrs['aria-expanded'] === 'true' && g[0].querySelector('.cg-body')!.hidden === false && g[0].classList.contains('open');
    const calm = prependHarness(src);
    calm.handle({ type: 'items', items: [toolItem('t3'), toolItem('t4'), textItem('a1')] });
    calm.handle({ type: 'earlier', items: [toolItem('t1'), toolItem('t2')], more: false });
    const stayed = groupsOf(calm.cs).length === 1 && groupsOf(calm.cs)[0].querySelector('.cg-body')!.hidden === true;
    // one call on show (a plain row) and an older one above it: they become a group, folded
    const one = prependHarness(src);
    one.handle({ type: 'items', items: [toolItem('t3'), textItem('a1')] });
    one.handle({ type: 'earlier', items: [toolItem('t1'), toolItem('t2')], more: false });
    const formed = groupsOf(one.cs).length === 1 && inBody(groupsOf(one.cs)[0]).length === 3 && groupsOf(one.cs)[0].querySelector('.cg-body')!.hidden === true && one.cs.items.size === 4;
    return joined && kept && stayed && formed;
  },
  (src) => src.replace(" || (m.csRec && opened.get(m.csRec.uuid) === true));", ');'));   // the new run is keyed by its new first call and forgets the old key

guarded('a run the operator unfolds, folds and then receives more older calls for stays folded: the keys it absorbed do not reopen it',
  (src) => {
    const h = prependHarness(src);
    h.handle({ type: 'items', items: [toolItem('t5'), toolItem('t6'), textItem('a1')] });
    const head = () => groupsOf(h.cs)[0].querySelector('.cg-head')!;
    const hidden = () => groupsOf(h.cs)[0].querySelector('.cg-body')!.hidden === true;
    head().click();                                                                              // unfolded
    h.handle({ type: 'earlier', items: [toolItem('t3'), toolItem('t4')], more: false });         // first older page
    const keptOpen = !hidden();
    head().click();                                                                              // the operator folds it
    const folded = hidden();
    h.handle({ type: 'earlier', items: [toolItem('t1'), toolItem('t2')], more: false });         // second older page
    return keptOpen && folded && hidden() && groupsOf(h.cs).length === 1 && inBody(groupsOf(h.cs)[0]).length === 6 && h.cs.groupOpen.size === 1;
  },
  (src) => src.replace("      for (const m of members) if (m.csRec && m.csRec.uuid !== key) opened.delete(m.csRec.uuid);", ''));   // the stale key of the first page stays true and wins over the fold

guarded('unfolding a group asks the view to follow the tail; folding it does not',
  (src) => {
    const { cs, handle, scrolls } = streamHarness(src);
    handle({ type: 'items', items: [toolItem('t1'), toolItem('t2')] });
    const before = scrolls.length;
    const head = groupsOf(cs)[0].querySelector('.cg-head')!;
    head.click();
    const afterOpen = scrolls.length;
    head.click();
    return afterOpen === before + 1 && scrolls[afterOpen - 1] === cs && scrolls.length === afterOpen;
  },
  (src) => src.replace('    if (g.open) chatSkinScroll(cs);', '    if (false) chatSkinScroll(cs);'));

guarded('a reset forgets the groups and what was open, so a new transcript never inherits a node or an open state',
  (src) => {
    const { cs, handle } = streamHarness(src);
    handle({ type: 'items', items: [toolItem('t1'), toolItem('t2')] });
    groupsOf(cs)[0].querySelector('.cg-head')!.click();
    handle({ type: 'reset' });
    handle({ type: 'items', items: [toolItem('t1'), toolItem('t2')] });
    return groupsOf(cs).length === 1 && cs.groups.size === 1 && groupsOf(cs)[0].querySelector('.cg-head')!.attrs['aria-expanded'] === 'false';
  },
  (src) => src.replace('cs.items.clear(); cs.groups.clear(); cs.groupOpen.clear();', 'cs.items.clear();'));

guarded('the group is only repainted, never rebuilt: the spinner node survives other calls landing, and rows already in place are not moved',
  (src) => {
    const { cs, handle } = streamHarness(src);
    handle({ type: 'items', items: [toolItem('t1', 'Bash', 'running', 'a'), toolItem('t2', 'Read', 'running', 'b')] });
    const g = groupsOf(cs)[0];
    const spin = g.querySelector('.ct-spin');
    const moves: string[] = [];
    const body = g.querySelector('.cg-body')!;
    const orig = body.insertBefore.bind(body);
    body.insertBefore = (n: Dn, r: Dn | null): Dn => { moves.push(n.className); return orig(n, r); };
    handle({ type: 'items', items: [toolItem('t2', 'Read', 'running', 'bb')] });   // a repaint with nothing new
    handle({ type: 'items', items: [toolItem('t3', 'Grep', 'running', 'c')] });    // one new row at the end
    return !!spin && g.querySelector('.ct-spin') === spin && moves.length === 1;
  },
  (src) => src.replace('    if (parent.children[i] !== w) parent.insertBefore(w, parent.children[i] || null);', '    parent.insertBefore(w, parent.children[i] || null);'));

test('the folded row\'s sentences exist in every locale with the same placeholders, and the failure count has a singular and a plural', () => {
  const keys = ['chat.skin.tg.count', 'chat.skin.tg.each', 'chat.skin.tg.failed.one', 'chat.skin.tg.failed.other'];
  const holders = (l: string, k: string): string => (loc[l][k].match(/\{\w+\}/g) ?? []).sort().join();
  for (const l of Object.keys(loc)) for (const k of keys) assert.ok(typeof loc[l][k] === 'string' && loc[l][k].length > 0, `${l}.json lacks ${k}`);
  for (const k of keys) { assert.equal(holders('es', k), holders('en', k), `es ${k}`); assert.equal(holders('pt-br', k), holders('en', k), `pt-br ${k}`); }
  assert.equal(holders('en', 'chat.skin.tg.each'), '{name},{n}');
  assert.equal(holders('en', 'chat.skin.tg.count'), '{n}');
  for (const l of ['es', 'pt-br']) assert.notEqual(loc[l]['chat.skin.tg.failed.one'], loc[l]['chat.skin.tg.failed.other'], `${l}: one failure and several are different words`);
  // the code asks for exactly these keys (a typo would show the key itself)
  for (const k of keys) assert.ok(skin.includes(`'${k}'`), `${k} is used`);
  // control: a locale that dropped a placeholder is caught by the same comparison
  assert.notEqual((loc.es['chat.skin.tg.count'] as string).replace('{n}', ''), loc.es['chat.skin.tg.count']);
  assert.notEqual(holders('en', 'chat.skin.tg.each'), '{name}');
});

test('the folded row\'s CSS: as short as a tool row, the call in progress only while it runs, ellipsis, status hues from --st-*, no coral', () => {
  const rules = skinRules(css);
  const decl = (sel: string): string => rules.filter(([x]) => x === sel).map(([, d]) => d).join(' ');
  const head = decl('.cg-head');
  assert.ok(Number(/min-height:\s*(\d+)px/.exec(head)?.[1]) >= 26 && Number(/min-height:\s*(\d+)px/.exec(head)?.[1]) <= 30, 'the group row is 26-30 px tall, like a tool row');
  assert.ok(Number(/padding:\s*(\d+)px/.exec(head)?.[1]) <= 4);
  assert.match(decl('.cg-head'), /min-height: 28px/);
  assert.equal(/min-height:\s*(\d+)px/.exec(decl('.ct-head'))?.[1], /min-height:\s*(\d+)px/.exec(head)?.[1], 'the same height as a single tool row');
  assert.match(decl('.cg-list, .cg-live'), /text-overflow: ellipsis/);
  assert.match(decl('.cg-la'), /text-overflow: ellipsis/);
  assert.match(decl('.chat-tg.running .cg-list, .chat-tg:not(.running) .cg-live'), /display: none/);
  assert.match(decl('.chat-tg.ok .cg-state'), /--st-ok-ink/);
  assert.match(decl('.chat-tg.error .cg-state'), /--st-error-ink/);
  assert.match(decl('.cg-fail'), /--st-error-ink/);
  assert.match(decl('.chat-tg.error .cg-kind'), /--st-error/);
  assert.match(decl('.chat-tg.open > .cg-head .ct-chev'), /rotate\(90deg\)/);
  assert.match(decl('.chat-tool, .chat-tg'), /margin: var\(--cs-m\) 0/);
  assert.match(decl('.cg-body > .chat-tool'), /border-radius: 0/);
  assert.match(decl('.cg-fail[hidden]'), /display: none/, 'the hidden attribute is not overridden by the chip\'s own display');
  for (const sel of ['.chat-tg', '.cg-head', '.cg-kind', '.cg-fail', '.chat-tg.error .cg-kind', '.chat-tg.ok .cg-state', '.chat-tg.error .cg-state']) assert.doesNotMatch(decl(sel), /--accent/, `${sel} must not use coral`);
  // the folded row shares the spinner, whose reduced-motion fallback the skin already has
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.ct-spin \{ animation: none; \}/);
  // the old joined-card classes are gone from code and sheet
  assert.doesNotMatch(css, /\.tg-(solo|first|mid|last)/);
  assert.doesNotMatch(skin, /tg-(solo|first|mid|last)/);
  // control: a rule that kept the old joined look, or an accent-coloured mark, is caught
  assert.match(decl('.cg-head') + ' min-height: 36px;', /min-height: 36px/);
  assert.notEqual(/min-height:\s*(\d+)px/.exec('min-height: 36px')?.[1], /min-height:\s*(\d+)px/.exec(head)?.[1]);
  assert.match('.chat-tg.ok .cg-state { color: var(--accent); }', /--accent/);
});

// ── the v3 shots: no header, the effort menu, the folded run (live · failed · unfolded with a row open) ──────────────

const V3_SCENARIOS: Array<[string, string]> = [['no-header', 'headerShot'], ['effort-menu', 'effortShot'], ['group-live', 'groupShot'], ['group-done-fail', 'groupShot'], ['group-open-row', 'groupShot']];
const v3Names = (): string[] => V3_SCENARIOS.flatMap(([n]) => ['dark', 'light'].flatMap((th) => [`${n}-${th}`, `${n}-narrow-${th}`]));
/** What a stream of tool calls looks like to the folded row: the longest run, how many are running, how many failed. */
function runFacts(events: FxEvent[]): { run: number; running: number; failed: number; turnOpen: boolean } {
  const items = events.filter((e) => e.type === 'items').flatMap((e) => e.items ?? []);
  let run = 0, best = 0;
  for (const i of items) { run = i.role === 'tool' ? run + 1 : 0; best = Math.max(best, run); }
  const tools = items.filter((i) => i.role === 'tool').map((i) => i.tool as FxTool);
  const last = [...events].reverse().find((e) => e.type === 'turn');
  return { run: best, running: tools.filter((x) => x.status === 'running').length, failed: tools.filter((x) => x.status === 'error').length, turnOpen: last?.open === true };
}

test('chat-shot fixture: every v3 scenario is shot in dark and light, wide and narrow, through its shared helper', () => {
  const byName = (n: string): (FxShot & { clip?: string }) | undefined => fixture.shots.find((s) => s.name === n);
  const names = v3Names();
  assert.equal(names.length, 20);
  for (const [n, helper] of V3_SCENARIOS) for (const th of ['dark', 'light']) for (const sfx of ['', '-narrow']) {
    const shot = byName(`${n}${sfx}-${th}`);
    assert.ok(shot, `missing shot ${n}${sfx}-${th}`);
    assert.equal(shot?.theme, th);
    assert.match([shot?.js].flat().join('\n'), new RegExp(`await ${helper}\\(ctx[,)]`), `${shot?.name} goes through ${helper}`);
    if (sfx) assert.match([shot?.js].flat().join('\n'), /pane: \d+/, `${shot?.name}: a narrow PANE (the window width alone would only shrink the layout around it)`);
    // what is judged is the pane, except where the tab strip is the subject
    if (n !== 'no-header') assert.equal((shot as { clip?: string }).clip, 'pane', `${shot?.name} is cropped to the pane`);
  }
  // the Settings shots show the view selector with the font and size rows beside it (the workbench layout, so the tab is not hidden behind the maximised dock) and fail when they are not on screen together
  for (const n of ['settings-dark', 'settings-light']) {
    assert.equal(byName(n)?.layout, 'workbench', `${n} is shot in the workbench layout`);
    const js = [byName(n)?.js].flat().join('\n');
    assert.match(js, /data-setting="claudeView"[\s\S]*chat-pref-sample[\s\S]*not on screen together/, `${n} checks the selector and the sample are visible`);
    assert.match(js, /the open Claude tab is not in the mode the selector shows/, `${n} checks the page against the open tab`);
  }
  // the same page in Terminal mode: the font and size step aside; and the tab strip of a chat session, with no switch on it
  for (const th of ['dark', 'light']) {
    const t = byName(`settings-terminal-${th}`);
    assert.equal(t?.layout, 'workbench');
    assert.match([t?.js].flat().join('\n'), /chatSkinSetMode\('terminal'[\s\S]*still shown in Terminal mode/, `settings-terminal-${th} checks the rows stepped aside`);
    const tab = byName(`tab-${th}`);
    assert.equal(tab?.theme, th);
    assert.match([tab?.js].flat().join('\n'), /the tab has a view switch again/, `tab-${th} fails if a switch comes back`);
  }
  // the helpers fail the run, they do not just take a picture
  const setup = [fixture.setup].flat().join('\n');
  assert.match(setup, /the chat view has a header again/);
  assert.match(setup, /the tab has a view switch again/);
  assert.match(setup, /a gap above the log/);
  assert.match(setup, /the effort menu is cut off by the pane/);
  assert.match(setup, /the effort menu overlaps the bar/);
  assert.match(setup, /no level is checked in the effort menu/);
  assert.match(setup, /was not folded into a group/);
  assert.match(setup, /the group did not unfold with the failed row open/);
  assert.match(setup, /the summary row text overflows its row/);
  // a QA helper only looks: nothing it does can reach the pty or pick a level
  assert.doesNotMatch(setup + names.map((n) => [byName(n)?.js].flat().join('\n')).join('\n'), /ptyWrite|chatSkinSubmit|chatSkinEffortPick|\.cbp-opt[^'"]*['"]\)\.click/);
});

test('chat-shot fixture: the streams behind the folded-run shots really are a live run, and a finished run with exactly one failure', () => {
  const live = runFacts(fixture.streams['tools-live']);
  assert.ok(live.run >= 5 && live.running === 1 && live.failed === 0 && live.turnOpen, `live: ${JSON.stringify(live)}`);
  const fail = runFacts(fixture.streams['tools-fail']);
  assert.ok(fail.run >= 5 && fail.running === 0 && fail.failed === 1 && !fail.turnOpen, `fail: ${JSON.stringify(fail)}`);
  // the live one ends on the running call, so the row can show the action in progress
  const liveItems = fixture.streams['tools-live'].filter((e) => e.type === 'items').flatMap((e) => e.items ?? []);
  assert.equal((liveItems[liveItems.length - 1].tool as FxTool).status, 'running');
  // controls: a stream with two failures, or with nothing running, is not what the shots claim
  const two = JSON.parse(JSON.stringify(fixture.streams['tools-fail'])) as FxEvent[];
  ((two.find((e) => e.type === 'items') as FxEvent).items as FxItem[]).find((i) => i.tool?.status === 'ok')!.tool!.status = 'error';
  assert.notEqual(runFacts(two).failed, 1);
  const calm = JSON.parse(JSON.stringify(fixture.streams['tools-live'])) as FxEvent[];
  ((calm.find((e) => e.type === 'items') as FxEvent).items as FxItem[]).forEach((i) => { if (i.tool) i.tool.status = 'ok'; });
  assert.equal(runFacts(calm).running, 0);
  // the effort and the bar are the ones the menu is opened from: an idle turn, a known level, so the segment is a live button
  const idle = runFacts(fixture.streams['bar-idle']);
  assert.equal(idle.turnOpen, false);
  assert.equal((fixture.streams.conversation.find((e) => e.type === 'status') as FxEvent).effort, 'high');
});

test('v3 polish: a run in progress wears the busy hue (with the ink spinner), the first row has no gap above it, the open effort segment reads as owner', () => {
  const rule = (sel: string, src: string): string => new RegExp(`${sel.replace(/[.[\]()+]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(src)?.[1] ?? '';
  const busy = rule('.chat-tg.running .cg-kind', css);
  assert.match(busy, /var\(--st-busy-ink\)/);
  assert.match(busy, /color-mix\(in srgb, var\(--st-busy\)/);
  assert.doesNotMatch(busy, /--accent/, 'coral never means a state');
  assert.match(rule('.chat-tg.running .ct-spin', css), /border-top-color: var\(--st-busy-ink\)/);
  assert.match(rule('.chat-log > .cs-state[hidden] + .chat-row', css), /margin-top: 0/);
  assert.match(rule('.cb-effort[aria-expanded="true"], .cb-effort[aria-expanded="true"] .cb-v', css), /color: var\(--ink\)/);
  // no hex in any of it (the token-only rule), and the spinner still has its reduced-motion fallback
  assert.doesNotMatch(busy + rule('.chat-tg.running .ct-spin', css), /#[0-9a-fA-F]{3,8}\b/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{ \.ct-spin \{ animation: none; \}/);
  // controls: a coral running chip, a missing gap rule, or a lost rule are all caught
  assert.match(busy.replace('--st-busy-ink', '--accent'), /--accent/);
  assert.equal(rule('.chat-log > .cs-state[hidden] + .chat-row', css.replace('.cs-state[hidden] + .chat-row', '.cs-state + .chat-x')), '');
  assert.equal(rule('.chat-tg.running .cg-kind', css.replace('.chat-tg.running .cg-kind', '.chat-tg.zzz .cg-kind')), '');
});

// ── the pane moves to another session: /clear and resume ────────────────────
//
// `/clear` and `/resume` start a NEW session inside the SAME claude process: the pty and the tab stay, the registry entry of that pid
// carries a new id, the old id disappears. Measured on a real session (AIOS_SMOKE_CHAT=1 smoke, stage 8): the pane has to (1) NOT take the
// old id's disappearance for the session ending, (2) follow the new id, (3) show nothing of the session it left, and (4) ignore what the
// old transcript's tail had already put on the wire. These tests EXECUTE the real functions on a stand-in pane.

type SessHarness = {
  p: Record<string, any>; cs: Record<string, any>; watches: Array<[number, string | null]>; unwatches: number[];
  viewCalls: Array<[number, string]>; renames: string[]; persisted: number; lookups: number[];
  handle: (ev: Record<string, unknown>) => void; changed: () => void; follow: () => void;
  under: { value: Record<number, { id: string; name: string }> | 'throw' };
};
const SESS_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SESS_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
function sessionHarness(src: string): SessHarness {
  const s = slice(src);
  const parts = [
    /const CS_TAIL_EVENTS = [^\n]*/.exec(s)?.[0] ?? '',
    fnBody(s, 'chatSkinEligible'), fnBody(s, 'chatSkinSessionChanged'), fnBody(s, 'chatSkinSync'),
    fnBody(s, 'chatSkinResetView'), fnBody(s, 'chatSkinHandleEvent'),
    /const rotateInFlight = new Set\(\);/.exec(src)?.[0] ?? '', fnBody(src, 'followRotatedId'),
  ].join('\n');
  const watches: Array<[number, string | null]> = []; const unwatches: number[] = []; const viewCalls: Array<[number, string]> = [];
  const renames: string[] = []; const lookups: number[] = [];
  let persisted = 0;
  const under: SessHarness['under'] = { value: {} };
  const cs: Record<string, any> = {
    watched: SESS_A, gen: 0, items: new Map(), groups: new Map(), groupOpen: new Map(), log: { replaceChildren: () => undefined },
    stateEl: {}, workEl: {}, state: 'live', turnOpen: true, stalled: false, ctxTokens: 52000, model: 'm', resetAt: 0, stick: false, lastEventAt: 0, idChecks: 0,
  };
  const p: Record<string, any> = { kind: 'term', view: 'chat', isSession: true, sessionId: SESS_A, confirmedName: 'smoke', chatSkin: cs };
  const panes = new Map<number, Record<string, any>>([[1, p]]);
  const window = { glassShell: {
    chatSkinWatch: async (id: number, sid: string | null) => { watches.push([id, sid]); return { ok: false, error: 'not-found' }; },
    chatSkinUnwatch: async (id: number) => { unwatches.push(id); },
    sessionUnder: async (ids: number[]) => { lookups.push(...ids); if (under.value === 'throw') throw new Error('no ps'); return under.value; },
  } };
  const noop = (): void => undefined;
  const make = new Function('panes', 'window', 'chatSkinSetView', 'paneIsClaude', 'chatSkinPaintState', 'chatSkinLayout', 'chatSkinScreenSoon', 'chatPaintUsage', 'chatSkinCardPaint',
    'chatSkinUpsert', 'chatSkinRegroup', 'chatSkinScroll', 'chatSkinPaintJump', 'chatSkinControls', 'chatSkinPaintAlert', 'chatSkinStreamDrop', 'chatSkinStream', 'chatSkinPrompt',
    'chatReducedMotion', 'CS_ANIM_AFTER_MS', 'renamePane', 'persistSessions',
    `${parts}\nreturn { handle: chatSkinHandleEvent, changed: (id, pane) => chatSkinSessionChanged(id, pane), follow: (id, pane) => followRotatedId(id, pane) };`) as (...a: unknown[]) => {
      handle: (ev: unknown) => void; changed: (id: number, pane: unknown) => void; follow: (id: number, pane: unknown) => void };
  const api = make(panes, window, (id: number, v: string) => { viewCalls.push([id, v]); }, () => false, noop, noop, noop, noop, noop,
    (c: any, it: any) => { c.items.set(it.uuid, it); }, noop, noop, noop, noop, noop, noop, noop, noop,
    () => true, 0, (_id: number, name: string) => { renames.push(name); }, () => { persisted++; });
  return {
    p, cs, watches, unwatches, viewCalls, renames, lookups, under,
    get persisted() { return persisted; },
    handle: (ev) => api.handle({ paneId: 1, ...ev }), changed: () => api.changed(1, p), follow: () => api.follow(1, p),
  } as SessHarness;
}
const itemsOf = (sid: string, ...texts: string[]): Record<string, unknown> => ({ type: 'items', sid, items: texts.map((t) => ({ uuid: `${sid.slice(0, 2)}-${t}`, role: 'user', text: t })) });

guarded('a pane that moves to another session shows nothing of the one it left, even if the new transcript does not exist yet (missing, not reset)',
  (src) => {
    const h = sessionHarness(src);
    h.handle({ type: 'reset', sid: SESS_A });
    h.handle(itemsOf(SESS_A, 'old question', 'old answer'));
    if (h.cs.items.size !== 2) return false;
    h.p.sessionId = SESS_B; h.changed();                    // /clear: the id changed, no transcript for it yet
    const emptied = h.cs.items.size === 0 && h.cs.watched === SESS_B && h.cs.ctxTokens === undefined && h.cs.turnOpen === false;
    h.handle({ type: 'missing', sid: SESS_B });             // all main says while the file does not exist
    const stillEmpty = h.cs.items.size === 0 && h.viewCalls.length === 0 && h.watches.length === 1 && h.watches[0][1] === SESS_B;
    h.handle({ type: 'reset', sid: SESS_B }); h.handle(itemsOf(SESS_B, 'new question'));   // the file appears
    return emptied && stillEmpty && [...h.cs.items.keys()].join() === 'bb-new question';
  },
  (src) => src.replace('if (prev) { chatSkinResetView(p);', 'if (false) { chatSkinResetView(p);'));
guarded('an event read from the transcript the pane has left is dropped, whatever it is; the events of the one it follows are not',
  (src) => {
    const h = sessionHarness(src);
    h.p.sessionId = SESS_B; h.changed();                    // moved on to B; A's tail had events in flight
    h.handle(itemsOf(SESS_A, 'late old line')); h.handle({ type: 'turn', open: true, sid: SESS_A });
    h.handle({ type: 'usage', contextTokens: 99000, sid: SESS_A }); h.handle({ type: 'reset', sid: SESS_A }); h.handle({ type: 'error', code: 'x', sid: SESS_A });
    const dropped = h.cs.items.size === 0 && h.cs.turnOpen === false && h.cs.ctxTokens === undefined && h.cs.state === 'waiting';
    h.handle({ type: 'reset', sid: SESS_B }); h.handle(itemsOf(SESS_B, 'new line')); h.handle({ type: 'usage', contextTokens: 1200, sid: SESS_B });
    return dropped && h.cs.items.size === 1 && h.cs.ctxTokens === 1200;
  },
  (src) => src.replace("if (typeof ev.sid === 'string' && ev.sid !== cs.watched && CS_TAIL_EVENTS.includes(ev.type)) return;", ''));
guarded('resume back to the first session: the view is emptied, the original transcript backfills ONCE, and the other session\'s late events add nothing',
  (src) => {
    const h = sessionHarness(src);
    const backfill = (sid: string): void => { h.handle({ type: 'reset', sid }); h.handle(itemsOf(sid, 'q', 'a')); };
    backfill(SESS_A);
    h.p.sessionId = SESS_B; h.changed(); backfill(SESS_B); h.handle(itemsOf(SESS_B, 'b only'));
    h.p.sessionId = SESS_A; h.changed();                    // resume
    const emptied = h.cs.items.size === 0 && h.cs.watched === SESS_A;
    h.handle(itemsOf(SESS_B, 'b late'));
    backfill(SESS_A);
    h.handle(itemsOf(SESS_A, 'q', 'a'));                    // the same lines delivered again are an upsert by uuid, never a second bubble
    return emptied && [...h.cs.items.keys()].sort().join() === 'aa-a,aa-q' && h.watches.map((w) => w[1]).join() === `${SESS_B},${SESS_A}`;
  },
  (src) => src.replace('if (prev) { chatSkinResetView(p);', 'if (false) { chatSkinResetView(p);'));

async function rotationOutcome(src: string, under: SessHarness['under']['value'], prior = false): Promise<{ h: SessHarness; adopted: boolean }> {
  const h = sessionHarness(src);
  h.under.value = under;
  if (prior) h.p.idLostChecked = false;
  h.follow();
  await new Promise((r) => setImmediate(r));
  return { h, adopted: h.p.sessionId === SESS_B };
}
test('an id that left the registry is looked up in the process tree before it is called an ending (/clear, /resume), and only then is it one', async () => {
  const good = async (src: string): Promise<boolean> => {
    const moved = await rotationOutcome(src, { 1: { id: SESS_B, name: 'smoke' } });
    const m = moved.h;
    const followed = moved.adopted && m.p.idLostChecked === false && m.persisted === 1 && m.cs.watched === SESS_B && m.viewCalls.length === 0 && m.watches.length === 1 && m.watches[0][1] === SESS_B;
    const gone = await rotationOutcome(src, {});                           // nothing alive under the pty: the session really ended
    const stays = gone.h.p.sessionId === SESS_A && gone.h.p.idLostChecked === true && gone.h.persisted === 0;
    const same = await rotationOutcome(src, { 1: { id: SESS_A, name: 'smoke' } });   // the registry still says the old id: not a rotation
    const sameOk = same.h.p.sessionId === SESS_A && same.h.p.idLostChecked === true;
    const boom = await rotationOutcome(src, 'throw');                      // ps unavailable: the old behaviour (the next pulse ends it) rather than never ending
    const boomOk = boom.h.p.sessionId === SESS_A && boom.h.p.idLostChecked === true;
    const renamed = await rotationOutcome(src, { 1: { id: SESS_B, name: 'other-name' } });
    return followed && stays && sameOk && boomOk && renamed.h.p.confirmedName === 'other-name' && renamed.h.renames.join() === 'other-name';
  };
  assert.ok(await good(app), 'the real function must hold');
  assert.equal(await good(app.replace('    pane.sessionId = real.id;\n    pane.idLostChecked = false;', '    pane.idLostChecked = false;')), false, 'control: a rotation that never adopts the new id');
  assert.equal(await good(app.replace("if (!real || !real.id || real.id === was) { pane.idLostChecked = true; return; }", 'if (!real) return;')), false, 'control: no process under the pty must unlock the ending');
  assert.equal(await good(app.replace('    chatSkinSessionChanged(id, pane);   // the chat view follows', '    // (removed)   // the chat view follows')), false, 'control: the chat view must be told');
});
test('the pulse asks the process tree before declaring an ending, once per lost id, and a live id clears the question', () => {
  const block = /const liveNames = new Set\(everyone[\s\S]*?renamePane\(pid, t\('tab\.endedSession'[\s\S]*?\n    \}/.exec(app)?.[0] ?? '';
  const ok = (b: string): boolean => /if \(entry\) \{[\s\S]*pane\.idLostChecked = false;[\s\S]*continue;[\s\S]*\}\s*\n\s*\/\*[\s\S]*?\*\/\s*\n\s*if \(!pane\.idLostChecked\) \{ followRotatedId\(pid, pane\); continue; \}[\s\S]*pane\.isSession = false;/.test(b);
  assert.ok(ok(block), 'the lookup must sit between "alive under this id" and the ending');
  assert.equal(ok(block.replace('if (!pane.idLostChecked) { followRotatedId(pid, pane); continue; }', '')), false, 'control: without the lookup an id change is a death again');
  assert.equal(ok(block.replace('pane.idLostChecked = false;\n', '')), false, 'control: a pane that was asked once would never be asked again');
  assert.doesNotMatch(skin, /followRotatedId/, 'the skin does not own session identity: the lookup lives with the other adoption sites');
});

test('the real-session smoke gate exercises /clear and resume on the same ephemeral session, and checks what the pane shows and follows', () => {
  const g = /async function chatViewSmoke[\s\S]*?\n\}\n/.exec(main)?.[0] ?? '';
  const holds = (x: string): boolean => /typeIn\('\/clear'|watchChange\('\/clear', '\/clear'/.test(x) && /`\/resume \$\{idA\}`/.test(x) && /tail\.current\(paneId\)/.test(x)
    && /x\.watched === x\.sessionId/.test(x) && /are still visible after \/clear/.test(x) && /not doubled|duplicated rows after the backfill/.test(x) && /not the original file/.test(x);
  assert.ok(holds(g));
  assert.equal(holds(g.replace('`/resume ${idA}`', '`/help`')), false, 'control: no resume');
  assert.equal(holds(g.replace(/tail\.current\(paneId\)/g, 'null')), false, 'control: the tail is not looked at');
  assert.equal(holds(g.replace('are still visible after /clear', 'ok')), false, 'control: the old rows are not checked');
});

// ── history above the window: the view holds the TAIL of a transcript and asks for the rest ────────────────
//
// Main sends the last few hundred lines; every row the view receives stays in the DOM, so what is above is fetched on demand
// (scripts/chat-bench.mjs: without this, 50k lines meant 160k DOM nodes and 1.3 GB in the renderer). These tests EXECUTE the real
// handler, the real prepend and the real request gate on a stand-in log whose height is 100 px per row.

type PageHarness = {
  cs: Record<string, any>; order: string[]; requests: number[]; answer: { value: { ok: boolean } };
  handle: (ev: Record<string, unknown>) => void; want: () => void;
};
function pagingHarness(src: string): PageHarness {
  const s = slice(src);
  const parts = [
    /const CS_TAIL_EVENTS = [^\n]*/.exec(s)?.[0] ?? '', /const CS_EARLIER_NEAR_PX = [^\n]*/.exec(s)?.[0] ?? '',
    fnBody(s, 'chatSkinWantEarlier'), fnBody(s, 'chatSkinPrepend'), fnBody(s, 'chatSkinResetView'), fnBody(s, 'chatSkinHandleEvent'),
  ].join('\n');
  const order: string[] = []; const requests: number[] = [];
  const answer = { value: { ok: true } };
  const marker = { nextSibling: { row: 'first' } };
  const log = { scrollTop: 0, style: { overflowAnchor: '' }, get scrollHeight() { return order.length * 100; }, replaceChildren: () => { order.length = 0; } };
  const cs: Record<string, any> = {
    watched: SESS_A, items: new Map(), groups: new Map(), groupOpen: new Map(), log, stateEl: marker, workEl: {},
    earlier: false, earlierBusy: false, state: 'waiting', turnOpen: false, stalled: false, resetAt: 0, stick: false, lastEventAt: 0,
  };
  const p: Record<string, any> = { kind: 'term', view: 'chat', chatSkin: cs };
  const panes = new Map<number, Record<string, any>>([[1, p]]);
  const window = { glassShell: { chatSkinEarlier: async (id: number) => { requests.push(id); return answer.value; } } };
  let ins = 0;
  const noop = (): void => undefined;
  const make = new Function('panes', 'window', 'chatSkinUpsert', 'chatSkinRegroup', 'chatSkinScroll', 'chatSkinPaintJump', 'chatSkinControls', 'chatSkinPaintAlert', 'chatSkinPaintState',
    'chatSkinStreamDrop', 'chatSkinStream', 'chatSkinPrompt', 'chatReducedMotion', 'CS_ANIM_AFTER_MS', 'chatSkinCardPaint',
    `${parts}\nreturn { handle: chatSkinHandleEvent, want: (id, pane) => chatSkinWantEarlier(id, pane) };`) as (...a: unknown[]) => { handle: (ev: unknown) => void; want: (id: number, p: unknown) => void };
  const api = make(panes, window,
    (c: any, it: any, _animate: boolean, before: unknown) => { if (c.items.has(it.uuid)) return; c.items.set(it.uuid, it); if (before !== undefined) order.splice(ins++, 0, it.uuid); else order.push(it.uuid); },
    () => { ins = 0; }, noop, noop, noop, noop, noop, noop, noop, noop, () => true, 0, noop);
  return { cs, order, requests, answer, handle: (ev) => api.handle({ paneId: 1, sid: SESS_A, ...ev }), want: () => api.want(1, p) };
}
const rows = (ids: string[]): Array<Record<string, unknown>> => ids.map((u) => ({ uuid: u, role: 'user', text: u }));
const rowsEv = (...ids: string[]): Record<string, unknown> => ({ type: 'items', items: rows(ids) });
const earlierEv = (more: boolean, ...ids: string[]): Record<string, unknown> => ({ type: 'earlier', items: rows(ids), more });
const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

guarded('older rows go ABOVE the ones on show, oldest first, and the operator keeps their place; the end of the history is remembered',
  (src) => {
    const h = pagingHarness(src);
    h.handle({ type: 'reset' }); h.handle({ type: 'span', earlier: true }); h.cs.log.scrollTop = 900;
    h.handle(rowsEv('r4', 'r5', 'r6'));
    h.cs.log.scrollTop = 120;                                   // the operator is reading near the top of what is on show
    h.handle({ ...earlierEv(true, 'r1', 'r2', 'r3') });
    const above = h.order.join() === 'r1,r2,r3,r4,r5,r6' && h.cs.log.scrollTop === 120 + 300 && h.cs.earlier === true && h.cs.earlierBusy === false && h.cs.log.style.overflowAnchor === '';
    h.handle({ type: 'earlier', items: [], more: false });
    return above && h.cs.earlier === false && h.order.length === 6;
  },
  (src) => src.replace('chatSkinUpsert(cs, it, false, before);', 'chatSkinUpsert(cs, it, false);'));
guarded('what the view scrolled past keeps its screen position when older rows are added (scrollTop moves by the height added above)',
  (src) => {
    const h = pagingHarness(src);
    h.handle({ type: 'reset' }); h.handle({ type: 'span', earlier: true }); h.handle(rowsEv('r3', 'r4'));
    h.cs.log.scrollTop = 50;
    h.handle({ ...earlierEv(true, 'r1', 'r2') });
    return h.cs.log.scrollTop === 250;
  },
  (src) => src.replace('log.scrollTop = top + (log.scrollHeight - was);', 'log.scrollTop = top;'));
guarded('a short window that leaves nothing to scroll asks for the rows above by itself, and keeps asking until the view is filled',
  (src) => {
    const h = pagingHarness(src);
    h.handle({ type: 'reset' }); h.handle({ type: 'span', earlier: true });
    h.handle(rowsEv('r5'));                                     // scrollTop 0: nothing above to scroll to
    const asked = h.requests.length === 1;
    h.handle({ ...earlierEv(true, 'r4') }); // one row (100 px) did not push the view past the threshold: ask again
    const again = h.requests.length === 2;
    h.cs.log.scrollTop = 1000;
    h.handle({ ...earlierEv(true, 'r3') }); // scrollTop is now far from the top: stop
    return asked && again && h.requests.length === 2;
  },
  (src) => src.replace("if (cs.log.scrollTop < CS_EARLIER_NEAR_PX) chatSkinWantEarlier(id, p);   // the window did not fill", "if (false) chatSkinWantEarlier(id, p);   // the window did not fill"));
const askOutcome = async (src: string): Promise<boolean> => {
    const h = pagingHarness(src);
    h.want(); await settle();
    const nothing = h.requests.length === 0;                    // cs.earlier is false
    h.handle({ type: 'span', earlier: true });
    h.want(); h.want(); await settle();
    const once = h.requests.length === 1 && h.cs.earlierBusy === true;
    h.cs.log.scrollTop = 1000;
    h.handle({ ...earlierEv(true, 'r1') }); // answered: free again
    h.answer.value = { ok: false };
    h.want(); await settle();
    const refused = h.requests.length === 2 && h.cs.earlierBusy === false;   // ok:false clears the flag so the next scroll asks again
    h.cs.watched = null; h.want(); await settle();
    return nothing && once && refused && h.requests.length === 2;
};
test('one request at a time; none without something above or without a transcript; a refused request can be repeated', async () => {
  assert.ok(await askOutcome(app), 'the real gate must hold');
  assert.equal(await askOutcome(app.replace('  cs.earlierBusy = true;\n  Promise.resolve(window.glassShell.chatSkinEarlier(id))', '  Promise.resolve(window.glassShell.chatSkinEarlier(id))')), false, 'control: without the busy flag every scroll event asks again');
  assert.equal(await askOutcome(app.replace('.then((r) => { if (!r || !r.ok) cs.earlierBusy = false; })', '.then(() => undefined)')), false, 'control: a refused request would block paging for good');
});
guarded('rows from another session never land above this one: a late `earlier` of a transcript the pane left is dropped, and a reset forgets the paging state',
  (src) => {
    const h = pagingHarness(src);
    h.handle({ type: 'reset' }); h.handle({ type: 'span', earlier: true }); h.handle(rowsEv('b3', 'b4'));
    h.cs.earlierBusy = true;
    h.cs.watched = SESS_B;                                      // /clear or resume: the pane moved on while the request was in flight
    h.handle({ ...earlierEv(true, 'a1', 'a2'), sid: SESS_A });
    const dropped = h.order.join() === 'b3,b4' && h.cs.earlierBusy === true;
    h.handle({ type: 'reset', sid: SESS_B });
    const forgotten = h.order.length === 0 && h.cs.earlier === false && h.cs.earlierBusy === false;
    h.handle({ type: 'span', earlier: true, sid: SESS_B }); h.handle({ ...rowsEv('c9'), sid: SESS_B });
    h.handle({ ...earlierEv(false, 'c8'), sid: SESS_B });
    return dropped && forgotten && h.order.join() === 'c8,c9';
  },
  (src) => src.replace("const CS_TAIL_EVENTS = ['reset', 'span', 'earlier', ", "const CS_TAIL_EVENTS = ['reset', 'span', "));
test('the scroll listener asks for the rows above when the operator gets near the top, and the preload/main contract carries it', () => {
  const build = fnBody(skin, 'chatSkinBuild');
  const wired = (b: string): boolean => /log\.addEventListener\('scroll', \(\) => \{[\s\S]*?if \(log\.scrollTop < CS_EARLIER_NEAR_PX\) chatSkinWantEarlier\(id, p\);[\s\S]*?\}\);/.test(b);
  assert.ok(wired(build));
  assert.equal(wired(build.replace('chatSkinWantEarlier(id, p);', '')), false, 'control: without it only a short window would ever page');
  assert.match(preload, /chatSkinEarlier: \(paneId: number\)[^\n]*ipcRenderer\.invoke\('chatSkin:earlier', paneId\)/);
  const handler = /ipcMain\.handle\('chatSkin:earlier'[\s\S]*?\n\}\);/.exec(main)?.[0] ?? '';
  assert.match(handler, /k\.sender !== e\.sender\) return \{ ok: false \}/, 'only the window that owns the pane may ask');
  assert.match(handler, /tail\.loadEarlier\(id\)/);
  assert.doesNotMatch(handler.replace('k.sender !== e.sender', ''), /k\.sender !== e\.sender/, 'control: the ownership check is what the pattern found');
});
