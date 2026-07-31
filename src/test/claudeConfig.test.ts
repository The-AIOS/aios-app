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
  CLAUDE_KEYS, BUILTIN_OUTPUT_STYLES, readAt, setAt, readStore, readValue, coerce,
} from '../core/claudeConfig';

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
  // and an inferred store says so, rather than pretending to be confirmed
  assert.equal(CLAUDE_KEYS.copyOnSelect.storeUncertain, true);
  assert.ok(!CLAUDE_KEYS.claudeInChrome.storeUncertain, 'this one was confirmed on disk');
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
  // Remote Control is OFF until `remoteControlAtStartup` is written. This assertion used to say
  // ON, and that single wrong belief is what made the failure invisible: the Settings row read
  // "Remote control ✓" while every session the app launched was unreachable from the operator's
  // phone. A fallback is a CLAIM ABOUT CLAUDE, so a wrong one is not a cosmetic default.
  assert.equal(readValue('remoteControl', {}, {}), false, 'remote control defaults OFF until the key is written');
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
  assert.match(src, /const store = readStore\(key as string, readJson\(claudeSettingsPath\(\)\), readJson\(claudeJsonPath\(\)\)\);/);
  assert.match(src, /if \(store === 'settings'\) writeClaudeSettings\(mutate\);\n\s*else writeClaudeUserJson\(mutate\);/);
  // ~/.claude.json holds live session state: if it is missing or unparseable, bail rather
  // than writing a one-key file over it
  assert.match(src, /if \(!Object\.keys\(j\)\.length\) return;/);
  // atomic: a crash mid-write must not truncate the operator's session state
  assert.match(src, /const tmp = p \+ '\.tmp';[\s\S]{0,160}renameSync\(tmp, p\)/);
});

test('every registry key is surfaced in Settings, and every Settings row is in the registry', () => {
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  for (const id of Object.keys(CLAUDE_KEYS)) {
    assert.match(app, new RegExp(`'${id}'`), `${id} has no Settings row`);
  }
  // and the output-style list comes from Claude's built-ins plus the operator's own files
  assert.deepEqual(BUILTIN_OUTPUT_STYLES, ['default', 'Explanatory', 'Learning']);
  assert.match(fs.readFileSync('src/main/aios.ts', 'utf8'), /output-styles/);
});

test('labels and hints exist in every locale', () => {
  for (const loc of ['en', 'es', 'pt-br']) {
    const j = JSON.parse(fs.readFileSync(`src/i18n/locales/${loc}.json`, 'utf8')) as Record<string, string>;
    for (const key of ['outputStyle', 'claudeInChrome', 'copyOnSelect', 'reduceMotion', 'switchModels']) {
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
  // reduce motion and switch models are Claude's config — they sat in Advanced only
  // because of when they were added, which mixed two axes in one drawer
  for (const k of ['reduceMotion', 'switchModels']) {
    assert.match(app, new RegExp(`row\\(wrap, t\\('settings\\.${k}'\\)`), `${k} belongs with Claude's settings`);
    assert.doesNotMatch(app, new RegExp(`row\\(wrapAdv, t\\('settings\\.${k}'\\)`));
  }
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
