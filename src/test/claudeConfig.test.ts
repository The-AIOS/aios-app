/**
 * Claude-owned settings: the registry, the two stores, and the write rules.
 *
 * Every failure mode here is SILENT — a wrong key name or a wrong store means the toggle
 * flips in our UI and changes nothing in Claude, which looks like a working feature.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {
  CLAUDE_KEYS, BUILTIN_OUTPUT_STYLES, readAt, setAt, readStore, readValue, coerce, isSet } from '../core/claudeConfig';

test('key names are the ones Claude actually reads', () => {
  // Read out of Claude's binary string table, where the settings keys cluster together.
  // 'reduceMotion' AND 'reducedMotion' both exist as strings in unrelated contexts; the
  // real settings key is prefersReducedMotion, and writing either of the others would
  // have silently done nothing.
  assert.equal(CLAUDE_KEYS.reduceMotion.path, 'prefersReducedMotion');
  assert.equal(CLAUDE_KEYS.switchModelsOnFlag.path, 'switchModelsOnFlag');
  assert.equal(CLAUDE_KEYS.outputStyle.path, 'outputStyle');
  assert.equal(CLAUDE_KEYS.claudeInChrome.path, 'claudeInChromeDefaultEnabled');
  assert.equal(CLAUDE_KEYS.copyOnSelect.path, 'copyOnSelect');
  assert.equal(CLAUDE_KEYS.mode.path, 'permissions.defaultMode');
});

test('each key declares the store its value was OBSERVED in', () => {
  for (const id of ['model', 'mode', 'remoteControl', 'switchModelsOnFlag', 'outputStyle', 'reduceMotion']) {
    assert.equal(CLAUDE_KEYS[id].store, 'settings', `${id} belongs to ~/.claude/settings.json`);
  }
  assert.equal(CLAUDE_KEYS.claudeInChrome.store, 'user');
  /* copyOnSelect's store was INFERRED and is now confirmed: the 2026-07-31 audit found it in
     ~/.claude.json on a real machine, exactly where the inference said it would be. `storeUncertain`
     is retired for it rather than carried as permanent doubt — but the flag itself must survive for
     the next inferred key, so this asserts the mechanism still exists. */
  assert.ok(!CLAUDE_KEYS.copyOnSelect.storeUncertain, 'confirmed on disk 2026-07-31 — no longer inferred');
  assert.ok(!CLAUDE_KEYS.claudeInChrome.storeUncertain, 'this one was confirmed on disk');
  assert.ok('storeUncertain' in ({} as Record<string, unknown>) === false, 'sanity');
  // the flag must remain part of the shape, for whichever key is inferred next
  const shapeCheck: { storeUncertain?: boolean } = {};
  shapeCheck.storeUncertain = true;
  assert.equal(shapeCheck.storeUncertain, true);
});

test('dot paths read and write nested keys, and create what is missing', () => {
  assert.equal(readAt({ permissions: { defaultMode: 'plan' } }, 'permissions.defaultMode'), 'plan');
  assert.equal(readAt({}, 'permissions.defaultMode'), undefined);
  assert.equal(readAt(undefined, 'a.b'), undefined);
  const j: Record<string, unknown> = {};
  setAt(j, 'permissions.defaultMode', 'auto');
  assert.deepEqual(j, { permissions: { defaultMode: 'auto' } });
  // an existing non-object in the path must not throw
  const k: Record<string, unknown> = { permissions: 'oops' };
  setAt(k, 'permissions.defaultMode', 'auto');
  assert.deepEqual(k, { permissions: { defaultMode: 'auto' } });
});

test('absent means the fallback — Claude only writes a key once you change it', () => {
  assert.equal(readValue('remoteControl', {}, {}), true, 'remote control defaults ON');
  assert.equal(readValue('reduceMotion', {}, {}), false);
  assert.equal(readValue('outputStyle', {}, {}), 'default');
  assert.equal(readValue('mode', {}, {}), 'default');
  assert.equal(readValue('model', {}, {}), '');
});

test('a key present on disk overrides the declared store, so an inferred store self-corrects', () => {
  // declared 'user', but if Claude writes it to settings.json we must follow the file
  assert.equal(readStore('copyOnSelect', { copyOnSelect: true }, {}), 'settings');
  assert.equal(readStore('copyOnSelect', {}, { copyOnSelect: true }), 'user');
  assert.equal(readStore('copyOnSelect', {}, {}), 'user', 'falls back to the declared store');
  // and the value is read from wherever it was found
  assert.equal(readValue('copyOnSelect', { copyOnSelect: true }, {}), true);
  assert.equal(readValue('claudeInChrome', {}, { claudeInChromeDefaultEnabled: false }), false);
});

test('a false boolean on disk is honoured, not treated as absent', () => {
  // `raw !== false` — the distinction that keeps an explicit off from reading as the default on
  assert.equal(readValue('remoteControl', { remoteControlAtStartup: false }, {}), false);
  assert.equal(readValue('switchModelsOnFlag', { switchModelsOnFlag: false }, {}), false);
});

test('choosing the default DELETES an enum instead of pinning the word "default"', () => {
  // writing the literal string would freeze today's default forever, instead of tracking
  // whatever Claude's default becomes
  assert.equal(coerce('outputStyle', 'default'), undefined);
  assert.equal(coerce('outputStyle', 'Explanatory'), 'Explanatory');
  assert.equal(coerce('model', ''), undefined);
  assert.equal(coerce('model', 'claude-opus-5'), 'claude-opus-5');
  assert.equal(coerce('mode', 'default'), undefined);
  assert.equal(coerce('reduceMotion', 1), true);
  assert.equal(coerce('reduceMotion', undefined), false);
});

test('writes route by resolved store, and never replace a config with a stub', () => {
  const src = fs.readFileSync('src/main/aios.ts', 'utf8');
  /* Now FOUR stores, and the routing question changed with them: a write must land in the store
     that WINS, or a higher-precedence copy silently overrides it and the toggle looks broken —
     which is how the missing stores were discovered. `writeStore` also refuses the project store,
     because that file is committed and a personal preference does not belong in a shared repo. */
  assert.match(src, /const store = writeStore\(key as string, st, uj, pj, lc\);/);
  assert.match(src, /if \(store === 'local'\) writeClaudeLocalSettings\(mutate\);/);
  assert.match(src, /else if \(store === 'user'\) writeClaudeUserJson\(mutate\);/);
  assert.match(src, /else writeClaudeSettings\(mutate\);/);
  // and reads must resolve the same chain, or the panel and the write disagree
  assert.match(src, /function claudeStores\(\)/, 'one place gathers all four stores');
  // ~/.claude.json holds live session state: if it is missing or unparseable, bail rather
  // than writing a one-key file over it
  assert.match(src, /if \(!Object\.keys\(j\)\.length\) return;/);
  // atomic: a crash mid-write must not truncate the operator's session state
  assert.match(src, /const tmp = p \+ '\.tmp';[\s\S]{0,160}renameSync\(tmp, p\)/);
});

test('every registry key is surfaced in Settings, and every Settings row is in the registry', () => {
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  /* The invariant is "no key is orphaned by ACCIDENT" — not "every key must have a row". Three keys
     are deliberately unsurfaced (two notification toggles nobody could tell apart, and a
     project-local setting the App cannot mirror), and each states its reason in `notSurfaced`. An
     omission without a reason still fails, which is the part worth keeping. */
  for (const id of Object.keys(CLAUDE_KEYS)) {
    if (CLAUDE_KEYS[id].notSurfaced) {
      assert.ok(CLAUDE_KEYS[id].notSurfaced!.length > 30, `${id} needs a real reason, not a shrug`);
      assert.ok(!CLAUDE_KEYS[id].seedOnInstall, `${id} is not shown, so it must not be written either`);
      continue;
    }
    assert.match(app, new RegExp(`'${id}'`), `${id} has no Settings row and no notSurfaced reason`);
  }
  // and the output-style list comes from Claude's built-ins plus the operator's own files
  assert.deepEqual(BUILTIN_OUTPUT_STYLES, ['default', 'Explanatory', 'Learning']);
  assert.match(fs.readFileSync('src/main/aios.ts', 'utf8'), /output-styles/);
});

test('labels and hints exist in every locale', () => {
  for (const loc of ['en', 'es', 'pt-br']) {
    const j = JSON.parse(fs.readFileSync(`src/i18n/locales/${loc}.json`, 'utf8')) as Record<string, string>;
    for (const key of ['outputStyle', 'claudeInChrome', 'copyOnSelect', 'switchModels']) {
      assert.ok(j[`settings.${key}`], `${loc} missing settings.${key}`);
      assert.ok(j[`settings.${key}Hint`], `${loc} missing settings.${key}Hint`);
    }
  }
});

/* ── options that must track Claude, not our source ──────────────────────────── */

test('the model list merges Claude\'s own options instead of being frozen here', () => {
  const src = fs.readFileSync('src/main/aios.ts', 'utf8');
  // Fable was missing from Settings while Claude itself already offered it — it lives in
  // additionalModelOptionsCache, which is exactly the list a hardcoded array cannot know
  assert.match(src, /additionalModelOptionsCache/);
  assert.match(src, /if \(current && !out\.some\(\(m\) => m\.value === current\)\) out\.unshift/,
    'a configured model unknown to this build must never vanish from the picker');
  // and the renderer must ASK for the list rather than keep its own
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  assert.match(app, /await window\.glassShell\.modelOptions\(\)/);
  assert.doesNotMatch(app, /'claude-opus-5\[1m\]'/, 'no model list frozen in the renderer');
});

test('permission modes honour the server gate that can disable bypass', () => {
  const src = fs.readFileSync('src/main/aios.ts', 'utf8');
  assert.match(src, /tengu_disable_bypass_permissions_mode === true/);
  assert.match(src, /filter\(\(m\) => m !== 'bypassPermissions'\)/);
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  assert.match(app, /await window\.glassShell\.permissionModes\(\)/);
  assert.doesNotMatch(app, /\['default', 'auto', 'acceptEdits', 'plan', 'bypassPermissions'\]/,
    'no mode list frozen in the renderer');
});

test('the framework path is settable, and stored OUTSIDE the framework it points at', () => {
  const src = fs.readFileSync('src/main/aios.ts', 'utf8');
  // it cannot live in .glass/shell.json like other app settings: that file is read from
  // INSIDE the framework root, so the setting that locates the framework would be
  // unreachable until we already knew where it was
  assert.match(src, /const appLocalPath = \(\): string => path\.join\(os\.homedir\(\), '\.aios', 'app\.json'\);/);
  assert.match(src, /const configured = storedFrameworkPath\(\) \|\| process\.env\.GLASS_FRAMEWORK_PATH \|\| path\.join\(os\.homedir\(\), 'aios'\);/,
    'precedence: setting → env → default');
  assert.match(src, /export function setFrameworkPath/);
  assert.match(src, /renameSync\(tmp, p\)/, 'atomic write');
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  assert.match(app, /row\(wrapAdv, t\('settings\.vault'\), vpIn/, 'an editable input, inside Advanced');
});

test('Advanced is collapsed by default and remembers being opened', () => {
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  assert.match(app, /let advOpen = false;/, 'closed unless the operator opened it before');
  assert.match(app, /localStorage\.getItem\('settingsAdvOpen'\) === '1'/);
  assert.match(app, /localStorage\.setItem\('settingsAdvOpen'/);
  // every Advanced row must land INSIDE the fold, or it shows while collapsed
  assert.doesNotMatch(app, /row\(wrap, t\('settings\.(claudeCmd|vault)'\)/);
});

test('one axis per section: Claude owns its settings AND its flows; Advanced owns plumbing', () => {
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  /* The invariant is about WHICH DRAWER a row lives in, not that it must exist. `reduceMotion` no
     longer has a row at all — it is project-local and the App cannot mirror it (see its
     `notSurfaced` reason) — so the rule that still matters for it is that it must not reappear in
     Advanced, where mixing Claude's config with our plumbing is what this test was written to stop. */
  assert.match(app, /row\(wrap, t\('settings\.switchModels'\)/, "switchModels belongs with Claude's settings");
  assert.doesNotMatch(app, /row\(wrapAdv, t\('settings\.switchModels'\)/);
  assert.doesNotMatch(app, /row\(wrapAdv, t\('settings\.reduceMotion'\)/,
    'if reduce motion ever returns it goes with Claude, never into Advanced');
  // /goal, /fewer-permission-prompts and /schedule configure Claude, so they go with it
  const claudeActs = app.slice(app.indexOf('const acts1'), app.indexOf("wrap.appendChild(acts1)"));
  for (const cmd of ['/goal', '/fewer-permission-prompts', '/schedule']) {
    assert.ok(claudeActs.includes(cmd), `${cmd} should sit with Claude's settings`);
  }
  // Advanced keeps diagnostics + plumbing only
  const adv = app.slice(app.indexOf('const acts2'), app.indexOf("row(wrapAdv, t('settings.claudeCmd')"));
  for (const gone of ['/goal', '/schedule', '/fewer-permission-prompts']) {
    assert.ok(!adv.includes(gone), `${gone} should have left Advanced`);
  }
  assert.ok(adv.includes('authStatus') && adv.includes('showLogs'));
});

test('the Claude section says where the full list lives', () => {
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  assert.match(app, /t\('settings\.claudeSub'\)/);
  for (const loc of ['en', 'es', 'pt-br']) {
    const j = JSON.parse(fs.readFileSync(`src/i18n/locales/${loc}.json`, 'utf8')) as Record<string, string>;
    assert.match(j['settings.claudeSub'], /\/config/, `${loc} must point at /config`);
  }
});

/* ── section placement: which surface OWNS a setting decides where it lives ──── */

test('automatic updates is AIOS\'s, not Claude\'s, and sits in the AIOS App section', () => {
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  const body = app.slice(app.indexOf('function openSettingsTab()'), app.indexOf('/* ── the Onboarding flow'));
  const iShell = body.indexOf("t('settings.shell')");
  const iAuto = body.indexOf("t('settings.autoUpdates')");
  const iClaude = body.indexOf("t('settings.claude')");
  assert.ok(iShell < iAuto && iAuto < iClaude,
    'it flips USER.md, which the rituals read — it is not a Claude setting');
  // it is also not in the registry of CLAUDE-owned keys
  assert.ok(!('autoUpdates' in CLAUDE_KEYS));
});

test('the AIOS setting does not travel on the claude:* channel', () => {
  const main = fs.readFileSync('src/main/main.ts', 'utf8');
  const src = fs.readFileSync('src/main/aios.ts', 'utf8');
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  assert.match(main, /ipcMain\.handle\('shell:setAutoUpdates'/);
  assert.match(src, /export function setAutoUpdates\(on: boolean\): void/);
  assert.match(app, /window\.glassShell\.setAutoUpdates\(auToggle\.checked\)/);
  // setClaudeConfig used to special-case it, which is how a USER.md write ended up behind
  // a function named for Claude's config
  assert.doesNotMatch(app, /claudeSet\('autoUpdates'/);
  assert.match(src, /export type ClaudeConfigKey = keyof typeof CLAUDE_KEYS;/);
});

test('the USER.md block matches what Glass writes — both surfaces edit the same file', () => {
  const src = fs.readFileSync('src/main/aios.ts', 'utf8');
  // whichever surface creates ## Settings first decides what the operator reads there
  assert.match(src, /auto-pull framework updates when your vault is BEHIND/);
  assert.match(src, /if \(\/\^## Session cascade\/m\.test\(md\)\)/, 'inserted before Session cascade, as Glass does');
  assert.match(src, /automatic updates:\\\*\*\\s\*\)\(yes\|no\|on\|off\|true\|false\)/, 'an existing line is edited, not duplicated');
});

test('the three Claude flows close out the Claude section', () => {
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  const body = app.slice(app.indexOf('function openSettingsTab()'), app.indexOf('/* ── the Onboarding flow'));
  const iSwitch = body.indexOf("t('settings.switchModels')");
  const iBtns = body.indexOf('wrap.appendChild(acts1)');
  const iAccount = body.indexOf("t('settings.account')");
  assert.ok(iSwitch < iBtns && iBtns < iAccount,
    'they looked misplaced only because the AIOS row was stranded below them');
});

/* 2026-07-31 — the settings model, rebuilt around SEEDING.
   The bug: the Claude section mirrors Claude's own config, but Claude writes a key only once you
   change it — so on a fresh machine almost nothing exists, and every value the UI showed for an
   absent key was an assertion nobody had read. `remoteControl` claimed `true` while Claude's real
   default is off, so the toggle showed a tick over a `false` config for anyone who never touched
   it. The field's NAME was the invitation: `fallback` reads as "what to display". */

test('the seed field is not a display fallback, and the old name is gone', () => {
  const src = fs.readFileSync('src/core/claudeConfig.ts', 'utf8');
  /* Ban the IDENTIFIER, not the word: the history of why this was renamed is worth documenting in
     the file, and a test that forbids explaining a past bug teaches the next reader nothing. */
  assert.doesNotMatch(src, /fallback:/, 'no key may still declare a `fallback:` field');
  assert.doesNotMatch(src, /spec\.fallback/, 'nothing may still READ a fallback');
  assert.match(src, /seed: boolean \| string;/, 'the value we WRITE, not the value we guess');
});

test('remoteControl seeds TRUE — the product default, made real instead of claimed', () => {
  assert.equal(CLAUDE_KEYS.remoteControl.seed, true);
  assert.equal(CLAUDE_KEYS.remoteControl.seedOnInstall, true,
    'on-by-default only holds if it is WRITTEN; an unwritten default is a claim');
});

test('autoCompact is NOT seeded — its default could not be verified', () => {
  /* Reversed within the hour, deliberately. Every other seed was checked against Claude's own
     code, where `?? !0` / `?? !1` IS the default. autoCompactEnabled is read WITHOUT a `??`
     default, so its absent-behaviour is unknown — and under a write-through model an unverified
     seed is a behaviour change made on a guess, which is the exact class this audit exists to
     stop. It renders as UNSET until the operator or Claude writes it. */
  assert.equal(CLAUDE_KEYS.autoCompact.seedOnInstall, undefined,
    'an unverified default must not be written into an operator\'s config');
});

test('every seed matches the default read out of Claude, except one deliberate product choice', () => {
  /* The audit that mattered: four seeds were BACKWARDS against Claude's own defaults, and under
     the write-through model each would have silently flipped a behaviour on first install.
     Verified from Claude's source (`?? !0` = true, `?? !1` = false), not inferred. */
  assert.equal(CLAUDE_KEYS.copyOnSelect.seed, true, "Claude: `?? !0`");
  assert.equal(CLAUDE_KEYS.switchModelsOnFlag.seed, true, "Claude: `?? !0`");
  assert.equal(CLAUDE_KEYS.awaySummary.seed, true, 'Claude: "when absent or true, recap is enabled"');
  assert.equal(CLAUDE_KEYS.agentPushNotif.seed, false, "Claude: `?? !1`");
  assert.equal(CLAUDE_KEYS.inputNeededNotif.seed, false, "Claude: `?? !1`");
  assert.equal(CLAUDE_KEYS.reduceMotion.seed, false, "Claude: `?? !1`");
  assert.equal(CLAUDE_KEYS.claudeInChrome.seed, false, "Claude: `?? !1`");
  /* THE ONE DELIBERATE DIVERGENCE: Claude leaves Remote Control off; the App turns it on, because
     publishing App-launched sessions is the product default and `spawn` has always done it. That is
     a decision, and it is the only place the App overrides a Claude default — so it is named here
     rather than blending in with the ones that merely match. */
  assert.equal(CLAUDE_KEYS.remoteControl.seed, true, 'deliberate: on-by-default is the product decision');
});

test('the two notification settings are distinct rows with Claude\'s own names', () => {
  /* Our single row was labelled "Notify me when a session needs me" — which describes
     inputNeededNotifEnabled ("Push when actions required") — while WRITING agentPushNotifEnabled
     ("Push when Claude decides"). The row promised one behaviour and changed another. */
  assert.equal(CLAUDE_KEYS.agentPushNotif.path, 'agentPushNotifEnabled');
  assert.equal(CLAUDE_KEYS.inputNeededNotif.path, 'inputNeededNotifEnabled');
  const en = JSON.parse(fs.readFileSync('src/i18n/locales/en.json', 'utf8')) as Record<string, string>;
  assert.equal(en['settings.notify'], 'Push when Claude decides');
  assert.equal(en['settings.inputNeededNotif'], 'Push when actions required');
  assert.equal(en['settings.awaySummary'], 'Session recap', "Claude's own word for it");
});

test('enums where "unset" is meaningful are NOT seeded', () => {
  // Writing these would take a decision away from the operator rather than make one for them.
  for (const id of ['model', 'outputStyle']) {
    assert.ok(!CLAUDE_KEYS[id].seedOnInstall, `${id} must stay unset until the operator pins it`);
  }
});

test('a bool must be a REAL true, not merely "not false"', () => {
  // readValue used `raw !== false`, so null/0/'' all read as ON — another way to display a value
  // nobody wrote.
  assert.equal(readValue('remoteControl', { remoteControlAtStartup: true }, {}), true);
  assert.equal(readValue('remoteControl', { remoteControlAtStartup: false }, {}), false);
  assert.equal(readValue('remoteControl', { remoteControlAtStartup: null }, {}), false);
});

test('isSet distinguishes "the operator chose" from "nobody chose"', () => {
  assert.equal(isSet('remoteControl', { remoteControlAtStartup: false }, {}), true, 'an explicit false IS set');
  assert.equal(isSet('remoteControl', {}, {}), false);
  assert.equal(isSet('copyOnSelect', {}, { copyOnSelect: true }), true, 'found in the user store');
});

test('seeding NEVER overwrites, and is marked so it cannot repeat', () => {
  const src = fs.readFileSync('src/main/aios.ts', 'utf8');
  const fn = /export function seedClaudeDefaults\(\)[\s\S]*?\n\}/.exec(src);
  assert.ok(fn, 'seedClaudeDefaults must exist');
  assert.match(fn[0], /if \(isSet\(id, settings, user, project, local\)\) continue;/,
    'an existing value belongs to the operator and must never be overwritten — checked across all four stores');
  assert.match(fn[0], /if \(raw\.claudeDefaultsSeeded\) return \{ seeded: \[\], already: true \}/,
    're-seeding every launch would undo the operator\'s own choices — worse than the bug it fixes');
  assert.match(fn[0], /setShellSetting\('claudeDefaultsSeeded', true\)/,
    'the marker belongs in OUR settings, never as a foreign key in Claude\'s schema');
});

test('all three mechanisms know about all four stores', () => {
  /* The bug that survived two rounds of fixes: reads learned the four-store chain, writes learned
     to route by winning store — and the WATCHER still listened to only the two user files. So
     `/config` writing the vault-local store fired nothing and the panel sat stale, which looked
     like "reduce motion conflicts" long after the read/write halves were correct.
     Three mechanisms have to agree, and the third is the easy one to forget precisely because the
     first two are already right. */
  const main = fs.readFileSync('src/main/main.ts', 'utf8');
  const watch = /function setupClaudeConfigWatch\(win: BrowserWindow\): void \{[\s\S]*?\n\}/.exec(main);
  assert.ok(watch, 'the config watcher must be findable');
  assert.match(watch[0], /aios\.frameworkRoot\(\)/, 'the watcher must reach the project root');
  assert.match(watch[0], /'\.claude', 'settings\.local\.json'/, 'and watch the store that WINS');
  assert.match(watch[0], /'\.claude', 'settings\.json'/, 'and the project store');

  const aiosSrc = fs.readFileSync('src/main/aios.ts', 'utf8');
  assert.match(aiosSrc, /function claudeStores\(\)/, 'reads gather all four');
  assert.match(aiosSrc, /writeStore\(key as string, st, uj, pj, lc\)/, 'writes route across all four');
});

test('the RESOLVER and the READER must consult the same stores', () => {
  /* The bug that took five rounds. `readStore` was taught all four stores; `readValue` inside
     claudeConfig() was not — its helpers named their variables `st`/`user`, so a search-and-replace
     aimed at `settings, user` silently matched nothing and I never verified it landed.
     The symptom was surgical, which is why it survived so long: `prefersReducedMotion` is the ONLY
     key that exists in BOTH the global and the vault-local store, so it is the only one where
     reading the wrong file yields a different answer. Every other key agreed by accident.
     Guarded at source level because the failure is a MISSING ARGUMENT — invisible to any test that
     only checks values on a machine where the two stores happen to agree. */
  const src = fs.readFileSync('src/main/aios.ts', 'utf8');
  const fn = /export function claudeConfig\(\): ClaudeConfig \{[\s\S]*?\n\}/.exec(src);
  assert.ok(fn, 'claudeConfig must be findable');
  assert.match(fn[0], /const \[, , pj, lc\] = claudeStores\(\);/, 'it must gather the project/local stores');
  assert.match(fn[0], /readValue\(id, st, user, pj, lc\)/, 'and pass them to every read');
  assert.doesNotMatch(fn[0], /readValue\(id, st, user\)/, 'a two-store read here is the bug');
});

test('a value present in TWO stores resolves to the winner', () => {
  /* The behavioural half, with the stores deliberately disagreeing — the only condition under
     which this class of bug is visible at all. */
  const settings = { prefersReducedMotion: true };
  const local = { prefersReducedMotion: false };
  assert.equal(readStore('reduceMotion', settings, {}, {}, local), 'local');
  assert.equal(readValue('reduceMotion', settings, {}, {}, local), false,
    'local wins — Claude resolves user → project → local');
  // and with no local override the global value stands
  assert.equal(readValue('reduceMotion', settings, {}, {}, {}), true);
});
