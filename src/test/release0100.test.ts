/**
 * 0.10.0 — behaviour the operator asked for, run against the real code.
 *
 * AI-165: Claude Code's daemon keeps pre-started spare sessions that register like any other
 * session but with no name, so the panel listed them under their ids and they came back when
 * closed. The registry already says which is which: spares are `kind: "bg"`, terminal sessions
 * `kind: "interactive"` (measured in the 2.1.282 binary; Claude Code's own FleetView filters the
 * same way).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as aios from '../main/aios';

function withRegistry(entries: object[], fn: () => void) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-home-'));
  const dir = path.join(home, '.claude', 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  /* AI-203: a session is listed only when it is the operator's — here, by running inside the
     framework. These tests are about kind/entrypoint, so every entry gets that cwd. */
  const fw = path.join(home, 'aios');
  fs.mkdirSync(fw, { recursive: true });
  entries.forEach((e, i) => fs.writeFileSync(path.join(dir, `${i + 1}.json`), JSON.stringify({ cwd: fw, ...e })));
  // Both: os.homedir() reads HOME on macOS/Linux and USERPROFILE on Windows (CI caught the Windows half).
  const saved = { h: process.env.HOME, u: process.env.USERPROFILE, f: process.env.GLASS_FRAMEWORK_PATH };
  process.env.HOME = home; process.env.USERPROFILE = home; process.env.GLASS_FRAMEWORK_PATH = fw;
  const restore = (k: 'HOME' | 'USERPROFILE' | 'GLASS_FRAMEWORK_PATH', v: string | undefined) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  try { fn(); } finally { restore('HOME', saved.h); restore('USERPROFILE', saved.u); restore('GLASS_FRAMEWORK_PATH', saved.f); fs.rmSync(home, { recursive: true, force: true }); }
}
// Two live pids so the dedupe-by-pid step keeps both; a third for the legacy entry.
const LIVE = [process.pid, process.ppid];

test('AI-165: a daemon spare is not an operator session; the terminal session beside it still shows', () => {
  withRegistry([
    { pid: LIVE[0], sessionId: 's-1', name: 'buddai', kind: 'interactive', status: 'idle' },
    { pid: LIVE[1], sessionId: '7a6c1978-spare', kind: 'bg', status: 'idle' },   // no name, like the real spares
  ], () => {
    const shown = aios.listOperatorSessions().map((a) => a.name);
    assert.deepEqual(shown, ['buddai'], 'the phantom "7a6c1978" row is gone');
    assert.equal(aios.listRunningAgents().length, 2,
      'the full list still has it: the spawn-inbox must still reach a named background agent');
  });
});

test('AI-165: a headless SDK run (a plugin, `claude -p`) is not an operator session either', () => {
  withRegistry([
    { pid: LIVE[0], sessionId: 's-1', name: 'buddai', kind: 'interactive', entrypoint: 'cli', status: 'idle' },
    { pid: LIVE[1], sessionId: '1dc5e420', name: 'aios-app-5e', kind: 'interactive', entrypoint: 'sdk-py', status: 'busy' },
  ], () => {
    assert.deepEqual(aios.listOperatorSessions().map((a) => a.name), ['buddai'], 'the security-review run is hidden');
  });
  for (const ep of ['cli', 'claude-desktop', 'claude-vscode', 'remote', ''])
    assert.equal(aios.isOperatorSession({ kind: 'interactive', entrypoint: ep }), true, `entrypoint "${ep}" is a person`);
  for (const ep of ['sdk-cli', 'sdk-py', 'sdk-ts'])
    assert.equal(aios.isOperatorSession({ kind: 'interactive', entrypoint: ep }), false, `entrypoint "${ep}" is a program`);
});

test('AI-165: a registry entry with no kind (an older Claude Code) is treated as a terminal session', () => {
  withRegistry([{ pid: LIVE[0], sessionId: 's-old', name: 'legacy', status: 'busy' }], () => {
    assert.deepEqual(aios.listOperatorSessions().map((a) => a.name), ['legacy']);
  });
});

test('AI-165: the panel, notifications and the palette use the operator list; the bus keeps the full one', () => {
  const host = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'panelHost.ts'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'main.ts'), 'utf8');
  const bus = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'commandBus.ts'), 'utf8');
  /* 0.11.0 (AI-196): the operator list is now overlaid with each session's own OSC 7501 status
     before it is read; what this guards is unchanged — the source is the OPERATOR list. */
  assert.match(host, /const registry = aios\.listOperatorSessions\(\);[\s\S]{0,300}const running = overlayProgramStatus\(registry, this\.programStatus\);\s*this\.attention\.tick/, 'panel rows + "needs you" notifications');
  assert.match(main, /running: aios\.listOperatorSessions\(\),/, 'the palette session list');
  assert.match(bus, /const all = aios\.listRunningAgents\(\);\s*const real = resolveSessionName\(name, all\.map\(\(a\) => a\.name\)\);/, 'send/kill still find background agents by name (the full list, any case)');
});

/* What's New for someone who skipped a release (operator's question, 2026-09-23). */
const app = fs.readFileSync('renderer/app.js', 'utf8');
const relSrc = /const RELEASES = \[[\s\S]*?\];/.exec(app)![0];
const skipSrc = /function skippedReleases\(from, to\) \{[\s\S]*?\n\}/.exec(app)![0];
const skipped = new Function(`${relSrc}\n${skipSrc}\nreturn skippedReleases;`)() as (a: string | null, b: string) => string[];

test('skipped releases are named exactly, from the list of what actually shipped', () => {
  assert.deepEqual(skipped('0.9.7', '0.9.9'), ['0.9.8'], '0.9.7 → 0.9.9 skipped 0.9.8');
  assert.deepEqual(skipped('0.9.8', '0.10.0'), ['0.9.9']);
  assert.deepEqual(skipped('0.9.9', '0.10.0'), [], 'the normal one-step update says nothing extra');
  assert.deepEqual(skipped(null, '0.10.0'), [], 'no previous version (first run, or opened by hand) → nothing');
  assert.deepEqual(skipped('0.3.2-dev', '0.10.0'), [], 'an unknown previous version → nothing, never a guess');
});

test('the release list cannot fall behind: this build\'s version must be in it', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { version: string };
  assert.ok(relSrc.includes(`'${pkg.version}'`),
    `package.json is ${pkg.version} but RELEASES does not list it — add it at the cut, or skipped-release notes go silent`);
});

/* #24 readability — ⌘+/− follows the focus. */
test('⌘+/− changes the terminal text when a terminal is focused, the editor zoom otherwise', () => {
  assert.match(app, /case 'zoom':[\s\S]{0,1600}const zt = zoomTarget\(\);\s*if \(zt && zt\.kind === 'term' && zt\.view === 'chat' && zt\.chatSkin\) \{\s*setChatFont\([\s\S]{0,200}if \(zt && zt\.kind === 'term' && zt\.term && !zt\.exited\) \{\s*setTermFont\(/, 'chat first (its overlay sits inside the terminal pane), then the terminal, then the editor');
  assert.match(app, /q\.term\.options\.fontSize = next;/, 'applied live to open terminals');
  assert.match(app, /setSetting\('termFontSize', TERMFONT\)/, 'and saved so new terminals match');
  assert.match(app, /fontIn\.addEventListener\('change', \(\) => setTermFont\(/, 'Settings uses the same live path');
});

test('#23: a waiting row shows what it is waiting for; at rest the hover buttons take no space', () => {
  assert.match(app, /if \(s\.cls === 'input' && a\.waitingFor\) \{/);
  const host = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'panelHost.ts'), 'utf8');
  assert.match(host, /mem: mem\[a\.pid\], waitingFor: a\.waitingFor, statusUpdatedAt: a\.statusUpdatedAt[,}]/, 'main sends it to the renderer');
  const css = fs.readFileSync('renderer/theme.css', 'utf8');
  assert.match(css, /\.prow2:not\(:hover\):not\(:focus-within\) \.runact:not\(\.has\) \{ display: none; \}/);
  assert.match(css, /body\.light \.zsplit \.pane\.termcard\.panefocus \{ border-color: var\(--accent\);/, '#24 (2c) light-theme focus border');
});

test('a drop anywhere clears every drop highlight (no coral ring left on the other zone)', () => {
  assert.match(app, /function clearAllDropHighlights\(\) \{\s*for \(const el of document\.querySelectorAll\('\.dropok, \.panedrop'\)\)/);
  assert.match(app, /document\.addEventListener\('drop', \(\) => setTimeout\(clearAllDropHighlights, 0\), true\);/, 'capture phase, after the target handled it');
  assert.match(app, /document\.addEventListener\('dragend', clearAllDropHighlights, true\);/);
});

test('AI-203: a session the operator never opened — a probe in another folder — is not listed', () => {
  withRegistry([
    { pid: LIVE[0], sessionId: 's-1', name: 'buddai', kind: 'interactive', entrypoint: 'cli', status: 'idle' },
    { pid: LIVE[1], sessionId: 's-2', name: 'osc-live', kind: 'interactive', entrypoint: 'cli', status: 'waiting', cwd: '/Users/x/code' },
  ], () => {
    assert.deepEqual(aios.listOperatorSessions().map((a) => a.name), ['buddai'], 'the probe that raised "osc-live needs you" is gone');
    assert.equal(aios.listRunningAgents().length, 2, 'the bus still sees it — hiding is a display rule, not a delivery rule');
  });
});
