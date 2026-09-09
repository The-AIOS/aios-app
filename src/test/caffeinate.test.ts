/**
 * Keep-awake policy (AI-132).
 *
 * The row this implements exists because the operator's workaround was a whole Claude session
 * standing in for a boolean — and because that workaround failed SILENTLY: session dies, machine
 * sleeps, nothing says so. So the tests care most about the two things that make a control real:
 * the state is derivable and honest, and the toggle always changes something.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {
  isBusyStatus, anyBusy, desiredBlocker, caffeinateReason, nextOverride, BLOCKER_TYPE,
  type CaffeinateMode,
} from '../core/caffeinate';

test('busy classification matches the renderer\'s own, and the duplication is GUARDED', () => {
  /* renderer/app.js cannot import src/core — index.html loads only node_modules UMD bundles, the
     generated i18n.js and app.js. So "what counts as busy" necessarily exists twice. That is the
     exact shape that let a rung table drift in AI-129, so it is guarded instead of tolerated:
     this reads the renderer's busy branch out of the source and requires the same three words. */
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  const line = app.split('\n').find((l) => l.includes("=== 'busy'")) ?? '';
  assert.ok(line, 'could not find the renderer busy branch — this guard would measure nothing');
  for (const word of ['busy', 'working', 'running']) {
    assert.ok(line.includes(`'${word}'`), `renderer treats '${word}' as busy; core must agree`);
    assert.equal(isBusyStatus(word), true, `core must treat '${word}' as busy`);
    assert.equal(isBusyStatus(word.toUpperCase()), true, 'case must not matter');
  }
  // and the renderer's branch must not have grown a word core does not know
  const words = [...line.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  for (const w of words) {
    assert.equal(isBusyStatus(w), true, `renderer's busy branch names '${w}' but core does not`);
  }
  for (const idle of ['idle', 'ready', '', '   ', 'waiting for input', 'error']) {
    assert.equal(isBusyStatus(idle), false, `'${idle}' is not busy`);
  }
});

test('anyBusy is the one input auto mode reads', () => {
  assert.equal(anyBusy([]), false, 'no sessions → nothing to keep awake for');
  assert.equal(anyBusy(['idle', 'idle']), false);
  assert.equal(anyBusy(['idle', 'busy']), true, 'one busy session is enough');
  assert.equal(anyBusy([null, undefined, 'working']), true, 'junk entries must not mask a busy one');
});

test('manual mode: the mode alone never holds the blocker — only the operator does', () => {
  assert.equal(desiredBlocker({ mode: 'manual', busy: false, override: null }), false);
  assert.equal(desiredBlocker({ mode: 'manual', busy: true, override: null }), false,
    'manual means MANUAL — a busy session must not quietly caffeinate a machine the operator set to manual');
  assert.equal(desiredBlocker({ mode: 'manual', busy: false, override: true }), true);
});

test('auto mode: the running sessions rule', () => {
  assert.equal(desiredBlocker({ mode: 'auto', busy: true, override: null }), true);
  assert.equal(desiredBlocker({ mode: 'auto', busy: false, override: null }), false,
    'all idle → release, or the machine never sleeps again');
});

test('the override wins in BOTH modes, and in both directions', () => {
  /* Operator-confirmed, arrived at independently: "even in automode, user might want to manually
     choose to stay awake even if no session is running." auto WITHOUT an override cannot express
     the original use case. And the reverse must work too — "let it sleep, I know what I'm doing"
     while something is busy — because a one-way override reads as a bug. */
  assert.equal(desiredBlocker({ mode: 'auto', busy: false, override: true }), true,
    'force awake with nothing running — the original use case');
  assert.equal(desiredBlocker({ mode: 'auto', busy: true, override: false }), false,
    'force sleep while busy — the same right, exercised the other way');
});

test('the toggle always changes something, and releases rather than freezes', () => {
  /* A toggle that appears to do nothing is worse than no toggle. And clicking back to the mode's
     own answer must RELEASE the override, not pin an identical value — otherwise `auto` silently
     stops following sessions while looking like it still does. */
  const cases: { mode: CaffeinateMode; busy: boolean }[] = [
    { mode: 'auto', busy: true }, { mode: 'auto', busy: false },
    { mode: 'manual', busy: true }, { mode: 'manual', busy: false },
  ];
  for (const c of cases) {
    const before = desiredBlocker({ ...c, override: null });
    const ov = nextOverride({ ...c, override: null });
    const after = desiredBlocker({ ...c, override: ov });
    assert.notEqual(after, before, `${c.mode}/busy=${c.busy}: one click must flip the effective state`);
    // click again → back to following the mode, not pinned
    const ov2 = nextOverride({ ...c, override: ov });
    assert.equal(ov2, null, `${c.mode}/busy=${c.busy}: the second click must RELEASE the override`);
    assert.equal(desiredBlocker({ ...c, override: ov2 }), before, 'and land back on the mode\'s answer');
  }
});

test('the reason names the STATE, never the action — and covers every branch', () => {
  const seen = new Set<string>();
  for (const mode of ['manual', 'auto'] as CaffeinateMode[]) {
    for (const busy of [true, false]) {
      for (const override of [null, true, false]) {
        seen.add(caffeinateReason({ mode, busy, override }));
      }
    }
  }
  assert.deepEqual([...seen].sort(),
    ['auto-busy', 'auto-idle', 'manual-off', 'override-off', 'override-on'],
    'every reason must be reachable, and no reason unreachable');
});

test('the blocker type is the system one, not the display one', () => {
  /* The ask is an awake machine, not a lit screen. `prevent-display-sleep` exists and takes
     precedence per Electron's docs — a future setting, not a default nobody requested. */
  assert.equal(BLOCKER_TYPE, 'prevent-app-suspension');
  const core = fs.readFileSync('src/core/caffeinate.ts', 'utf8');
  const code = core.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.doesNotMatch(code, /prevent-display-sleep/,
    'the display variant must not be reachable until it is a setting');
});

test('the wiring keeps every decision in main — the renderer shows and sends, nothing else', () => {
  /* The architectural constraint, guarded because it is invisible: renderer/app.js is a plain
     <script> and CANNOT import src/core (index.html loads UMD bundles, the generated i18n.js and
     app.js). So a renderer that decided anything here would be a second implementation of the
     policy — the AI-129 shape. It must only paint what main reports and send intent. */
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  const code = app.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.doesNotMatch(code, /powerSaveBlocker/, 'the blocker is a main-process API');
  assert.doesNotMatch(code, /desiredBlocker|nextOverride|anyBusy|isBusyStatus/,
    'the renderer must not re-implement the policy it cannot import');
  assert.match(code, /window\.glassShell\.caffeinateToggle\(\)/, 'it sends intent');
  assert.match(code, /window\.glassShell\.onCaffeinate\(paintCaffeine\)/, 'and it is pushed state');

  const main = fs.readFileSync('src/main/caffeinate.ts', 'utf8');
  assert.match(main, /powerSaveBlocker\.start\(BLOCKER_TYPE\)/);
  assert.doesNotMatch(main, /'caffeinate'\]|exec.*caffeinate|spawn.*caffeinate/,
    'never shell out to macOS `caffeinate` — the whole point is one cross-platform primitive');
});

test('the button reports the state it can OBSERVE, and admits when the platform refused', () => {
  /* isStarted() is Electron's bookkeeping, not proof the OS honoured the request. On Linux the
     blocker goes through D-Bus and silently does nothing without a session bus — this repo's own
     Linux verify logs "Failed to connect to the bus". So a UI that reads "on" because start()
     returned a number would be lying in exactly the case that matters. */
  const main = fs.readFileSync('src/main/caffeinate.ts', 'utf8');
  assert.match(main, /on: held\(\)/, 'report what is held, not what was wanted');
  assert.match(main, /unsupported: want && !held\(\)/, 'and name the asked-but-refused case');

  const app = fs.readFileSync('renderer/app.js', 'utf8');
  assert.match(app, /caff-warn/, 'the refused case must be visible, not swallowed');
  assert.match(app, /t\('caffeinate\.unsupported'\)/);
  /* The tooltip must carry the STATE, not only the control's name. Asserted as the presence of
     the state-aware assignment rather than as the ABSENCE of a bare one — this guard originally
     forbade `title = t('caffeinate.title')` outright and then fired on the fix for a real bug the
     operator reported (hovering showed nothing at all, because the only title assignment lived
     inside the paint, so there was none until the first state push landed). A base label is the
     correct fallback for that window; what must never happen is the state never being appended. */
  /* Asserted by INTENT, not by exact syntax. This assertion has now been rewritten twice because
     it pinned a literal line — first forbidding a base title, then naming `dragCaffeine.title = …`
     the moment the hover moved to a real tooltip element. A guard that fails on a correct
     refactor teaches people to edit guards, which is worse than the drift it was guarding. What
     must hold: the hover text combines the control's NAME with the current state's reason, and
     that text is what the tip actually renders. */
  /* FOURTH rewrite of this assertion, and the count is the point. Each earlier form pinned an
     exact line — a bare title, then `dragCaffeine.title = …`, then `tipEl.textContent = caffTip`
     — and each failed on a correct refactor rather than on a defect: the tooltip moving into a
     shared `attachTip` helper is an improvement, not drift. Over-specified guards train people to
     edit guards, which costs more than the drift they were written to catch. Asserted here as the
     WIRING that must hold: the button's tip is sourced from the state-derived text, and the tip
     text is derived from the control's name. */
  assert.match(app, /attachTip\(dragCaffeine, \(\) => caffTip\)/,
    "the button's hover must be sourced from the state-derived text");
  assert.match(app, /caffTip = t\('caffeinate\.title'\)/, 'and that text starts from the control name');
  assert.match(app, /let why = '';/, '`why` must have a default, not undefined');
  /* The label is PLATFORM-FREE. It read "Keep this Mac awake" while shipping to Windows and
     Linux from the same source — wrong on two of three platforms, and only the operator noticing
     caught it. The state words are gone from the normal case (the highlight says on-or-off), so
     the two that remain are the cases where the highlight alone would mislead. */
  const en = JSON.parse(fs.readFileSync('src/i18n/locales/en.json', 'utf8')) as Record<string, string>;
  for (const [k, v] of Object.entries(en)) {
    if (!k.startsWith('caffeinate.') && k !== 'settings.caffeinate' && k !== 'settings.caffeinateHint') continue;
    assert.doesNotMatch(v, /\bMac\b|macOS/, `${k} names a platform: "${v}"`);
  }
  /* Native `title` alone was not enough: every button in this title-bar cluster sets one and none
     appeared for the operator — `#drag` is the window's drag region. So a real element is required. */
  assert.match(app, /className = 'pathtip'/, 'reuse the existing hover-tip element, not a new mechanism');
  /* It must hide again — a tip left hanging over a changed UI is worse than none. Asserted on the
     shared helper's contract (a hide bound to mouseleave AND to click) rather than on a literal,
     for the reason the comment above gives. */
  assert.match(app, /const hide = \(\) => \{ if \(tipEl\) tipEl\.hidden = true; \};/);
  assert.match(app, /el\.addEventListener\('mouseleave', hide\);/);
  assert.match(app, /el\.addEventListener\('click', hide\);/, 'a click changes the UI under the tip');
});

test('every caffeinate string exists in all three locales', () => {
  /* Trimmed with the tooltip: the per-state sentences went away when the label became just the
     control's name (the highlight carries on-or-off). What survives is the name, the two cases
     where the highlight would mislead, and the Settings row. Dead keys are DELETED rather than
     left behind — a stale key reads as a live one to whoever edits a locale file next. */
  const keys = ['caffeinate.title', 'caffeinate.unsupported',
    'settings.caffeinate', 'settings.caffeinateHint', 'caffeinate.modeAuto', 'caffeinate.modeManual'];
  /* `caffeinate.overriding` joined these once the DOT carried the override — a tooltip repeating
     what a visual already says is the noise the operator asked the label to shed. */
  const gone = ['caffeinate.on', 'caffeinate.offAuto', 'caffeinate.offManual', 'caffeinate.autoBusy',
    'caffeinate.overrideOn', 'caffeinate.overrideOff', 'caffeinate.overriding'];
  for (const loc of ['en', 'es', 'pt-br']) {
    const j = JSON.parse(fs.readFileSync(`src/i18n/locales/${loc}.json`, 'utf8')) as Record<string, string>;
    for (const k of keys) assert.ok(j[k], `${loc} is missing ${k}`);
    for (const k of gone) assert.ok(!(k in j), `${loc} still carries the retired ${k}`);
  }
  assert.match(fs.readFileSync('renderer/i18n.js', 'utf8'), /caffeinate\.unsupported/,
    'the generated bundle is stale — run npm run gen-i18n');
});

test('the mode is a setting with auto as the default, and only "manual" opts out', () => {
  const a = fs.readFileSync('src/main/aios.ts', 'utf8');
  assert.match(a, /caffeinate: raw\.caffeinate === 'manual' \? 'manual' : 'auto'/,
    'anything but the literal "manual" must land on auto — a typo may not silently disable it');
  const m = fs.readFileSync('src/main/main.ts', 'utf8');
  assert.match(m, /if \(key === 'caffeinate'\) caffeine\.modeChanged\(\);/,
    'changing the rule must retire any override, or auto visibly stops following sessions');
});

test('the dot means "your hand is on it" — in BOTH modes, one rule not two', () => {
  /* Operator's question: "when setting is manual for caffeinate, i wonder if we should show the
     dot as when overriding". Yes — because from their seat manual-and-on IS the overriding
     situation: they pressed the button and the machine is awake because they said so. Marking the
     same situation two different ways is what makes a control need explaining.
     Guarded because the previous rule (`mode === 'auto' && override !== null`) reads as the more
     careful one and would be re-introduced by anyone reasoning from "only auto has a rule to
     override" — which is true about the CODE and false about the operator's experience. */
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  assert.match(app, /classList\.toggle\('caff-override', !!\(st && st\.override !== null\)\)/,
    'the dot follows the override in any mode');
  assert.doesNotMatch(app, /caff-override'[^\n]*mode === 'auto'/,
    'gating the dot on auto is what left manual-and-on unmarked');

  /* And the reason the redundancy in manual is acceptable rather than noise: manual only ever
     cycles null <-> true, so the dot is never permanently lit — it tracks being held awake. */
  assert.equal(nextOverride({ mode: 'manual', busy: false, override: null }), true,
    'manual click turns it on');
  assert.equal(nextOverride({ mode: 'manual', busy: false, override: true }), null,
    'and clicking back RELEASES rather than pinning false — so the dot goes out');
  assert.equal(nextOverride({ mode: 'manual', busy: true, override: null }), true,
    'a busy session does not change manual: the button is the only authority');
});

test('the tooltip names the SETTING — the one thing no pixel on the button says', () => {
  /* Operator-raised: "do you think the tooltip for the coffee should state the setting?" Yes, and
     it is the only addition that passes this control's own rule. The rule has been "say only what
     no pixel says", which is why the override sentence was deliberately REMOVED (the dot carries
     it, and the operator asked the label to stop duplicating it). The mode is the case the rule
     was missing: the fill says on/off, the dot says whose hand it is, and nothing at all says
     whether an idle machine will fall asleep on its own — which is the question you hover this
     button to ask. */
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  assert.match(app, /caffTip = t\('caffeinate\.title'\) \+ ': ' \+ mode/,
    'the hover text is the control name plus its mode');
  assert.match(app, /st\.mode === 'manual' \? t\('caffeinate\.modeManualShort'\) : t\('caffeinate\.modeAutoShort'\)/,
    'and the mode is read from the pushed state, never remembered locally');

  /* The override must NOT come back into the words — that removal was the operator's call. */
  assert.doesNotMatch(app, /caffTip[^\n]*override/i, 'the dot carries the override; the label must not repeat it');

  /* Short labels, because a tooltip is not the settings picker. The long forms still exist for
     the picker itself and must not be reused here. */
  const en = JSON.parse(fs.readFileSync('src/i18n/locales/en.json', 'utf8')) as Record<string, string>;
  for (const k of ['caffeinate.modeAutoShort', 'caffeinate.modeManualShort']) {
    assert.ok(en[k], `missing ${k} — the tooltip would render its own key`);
    assert.ok(en[k].length <= 12, `${k} is a tooltip word, not a sentence: "${en[k]}"`);
  }
  assert.ok(en['caffeinate.modeAuto'].length > en['caffeinate.modeAutoShort'].length,
    'the picker keeps the explaining form; the tooltip gets the short one');
});

test('title-bar tooltips stay short — in EVERY locale, worst case included', () => {
  /* Operator-raised: "just be careful they are not massively long". Measured before this cap,
     the keep-awake tooltip composed to 90 chars in English and 111 in Spanish once the platform
     refused the request, against 16-30 for the normal case — a paragraph hanging off a 26px
     button. The normal case was never the problem, which is exactly why an eyeball check on the
     English happy path would have missed it: the blow-up needs a rare state AND the longest
     locale, and translations only get longer.
     So the bound is checked where it actually bites — composed, and per locale. */
  const LOCALES = ['en', 'es', 'pt-br'];
  const PLAIN = 24;      // a one-word control name, in any language
  const COMPOSED = 64;   // name + mode + the refusal reason, the worst a hover can render
  for (const loc of LOCALES) {
    const d = JSON.parse(fs.readFileSync(`src/i18n/locales/${loc}.json`, 'utf8')) as Record<string, string>;
    for (const k of ['window.manual', 'window.readme', 'window.cheatsheet', 'window.shortcuts',
                     'window.guide', 'rail.layout', 'caffeinate.title']) {
      assert.ok(d[k], `${loc}: missing ${k}`);
      assert.ok(d[k].length <= PLAIN,
        `${loc}: "${d[k]}" is ${d[k].length} chars — a title-bar tooltip is a label, cap ${PLAIN}`);
    }
    /* The composed worst case: the longer of the two mode words, plus a refusal. */
    const mode = [d['caffeinate.modeAutoShort'], d['caffeinate.modeManualShort']]
      .reduce((a, b) => (a.length >= b.length ? a : b));
    const worst = `${d['caffeinate.title']}: ${mode} · ${d['caffeinate.unsupported']}`;
    assert.ok(worst.length <= COMPOSED,
      `${loc}: the hover can render ${worst.length} chars — cap ${COMPOSED}. Got "${worst}"`);
  }
});

test('every chord the RENDERER handles alone is listed in the shortcuts sheet', () => {
  /* Operator-reported: "shortcuts page is missing the split shortcut". The sheet is built from
     the native menu's accelerators PLUS the RENDERER_KEYS list, so a chord handled only in
     renderer/app.js is discoverable únicamente if someone remembers to add it by hand — and
     `⌘\`, the gesture this release is named for, was in neither. Nothing derives the list, which
     is what makes this a guard rather than a comment: the failure is silent, the surface whose
     whole job is to answer "what can I press" simply omits it.
     Auditing the set found ⌘S undocumented too, which is the argument for checking all of them
     instead of adding back the one that was noticed. */
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  const list = /const RENDERER_KEYS = \[[\s\S]*?\n\];/.exec(app);
  assert.ok(list, 'RENDERER_KEYS must be findable — it is half of the shortcuts sheet');
  const menu = fs.readFileSync('src/main/menu.ts', 'utf8');
  const documented = (accel: string): boolean =>
    list![0].includes(`'${accel}'`) || menu.includes(`accelerator: '${accel}'`);

  /* The renderer's own handlers, each named by the key it matches, with the accelerator it must
     appear as. Adding a renderer chord means adding a line here too — deliberately, so the sheet
     cannot silently fall behind the app again. */
  /* ESCAPING, and it caught this guard on its first run: we are searching SOURCE TEXT, not
     comparing runtime values. In app.js the accelerator is written `'CmdOrCtrl+\\'` — two
     backslash characters in the file — so a TS literal `'CmdOrCtrl+\\'`, which evaluates to one
     backslash, never matches. String.raw gives the characters as they appear on disk, which is
     what `includes` needs. A guard that reads code has to speak the code's spelling. */
  const BACKSLASH = String.raw`CmdOrCtrl+\\`;
  const SHIFT_BACKSLASH = String.raw`CmdOrCtrl+Shift+\\`;
  const handled: Array<[string, string]> = [
    ["e.code === 'Backslash'", BACKSLASH],
    ["e.key === 's'", 'CmdOrCtrl+S'],
  ];
  for (const [handler, accel] of handled) {
    assert.ok(app.includes(handler), `sanity: the renderer still handles ${accel} (${handler})`);
    assert.ok(documented(accel),
      `${accel} is handled in the renderer and appears in NO menu and NO sheet row — invisible to the operator`);
  }
  /* The unsplit half is the same gesture and must not be half-documented. */
  assert.ok(documented(SHIFT_BACKSLASH), 'leaving the split needs a row too');
  /* And every row must carry a real label key, or the sheet renders raw key names. */
  for (const m of list![0].matchAll(/label: '([\w.]+)'/g)) {
    const en = JSON.parse(fs.readFileSync('src/i18n/locales/en.json', 'utf8')) as Record<string, string>;
    assert.ok(en[m[1]], `${m[1]} has no English label — the sheet would print the key`);
  }
});
