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
  assert.match(app, /caffTip = t\('caffeinate\.title'\)[^\n]*why/,
    'the hover text must combine the name with the state reason');
  assert.match(app, /tipEl\.textContent = caffTip/, 'and the tip must render that text');
  assert.match(app, /let why = t\('caffeinate\.offManual'\);/, '`why` must have a default, not undefined');
  /* Native `title` alone was not enough: every button in this title-bar cluster sets one and none
     appeared for the operator — `#drag` is the window's drag region. So a real element is required. */
  assert.match(app, /className = 'pathtip'/, 'reuse the existing hover-tip element, not a new mechanism');
  assert.match(app, /mouseleave.*tipEl\.hidden = true|tipEl\.hidden = true; \}\);/,
    'and it must hide again — a stuck tooltip is worse than none');
});

test('every caffeinate string exists in all three locales', () => {
  const keys = ['caffeinate.title', 'caffeinate.on', 'caffeinate.offAuto', 'caffeinate.offManual',
    'caffeinate.autoBusy', 'caffeinate.overrideOn', 'caffeinate.overrideOff',
    'caffeinate.unsupported', 'settings.caffeinate', 'settings.caffeinateHint',
    'caffeinate.modeAuto', 'caffeinate.modeManual'];
  for (const loc of ['en', 'es', 'pt-br']) {
    const j = JSON.parse(fs.readFileSync(`src/i18n/locales/${loc}.json`, 'utf8')) as Record<string, string>;
    for (const k of keys) assert.ok(j[k], `${loc} is missing ${k}`);
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
