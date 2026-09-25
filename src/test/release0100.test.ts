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
  entries.forEach((e, i) => fs.writeFileSync(path.join(dir, `${i + 1}.json`), JSON.stringify(e)));
  const saved = process.env.HOME;
  process.env.HOME = home;
  try { fn(); } finally { process.env.HOME = saved; fs.rmSync(home, { recursive: true, force: true }); }
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

test('AI-165: a registry entry with no kind (an older Claude Code) is treated as a terminal session', () => {
  withRegistry([{ pid: LIVE[0], sessionId: 's-old', name: 'legacy', status: 'busy' }], () => {
    assert.deepEqual(aios.listOperatorSessions().map((a) => a.name), ['legacy']);
  });
});

test('AI-165: the panel, notifications and the palette use the operator list; the bus keeps the full one', () => {
  const host = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'panelHost.ts'), 'utf8');
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'main.ts'), 'utf8');
  const bus = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'commandBus.ts'), 'utf8');
  assert.match(host, /const running = aios\.listOperatorSessions\(\);[^\n]*\n\s*this\.attention\.tick/, 'panel rows + "needs you" notifications');
  assert.match(main, /running: aios\.listOperatorSessions\(\),/, 'the palette session list');
  assert.match(bus, /aios\.listRunningAgents\(\)\.find\(\(a\) => a\.name === name\)/, 'send/kill still find background agents by name');
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
  assert.match(app, /case 'zoom':[\s\S]{0,700}if \(focusedTerminal\(\)\) \{\s*setTermFont\(/, 'terminal first');
  assert.match(app, /q\.term\.options\.fontSize = next;/, 'applied live to open terminals');
  assert.match(app, /setSetting\('termFontSize', TERMFONT\)/, 'and saved so new terminals match');
  assert.match(app, /fontIn\.addEventListener\('change', \(\) => setTermFont\(/, 'Settings uses the same live path');
});

test('#23: a waiting row shows what it is waiting for; at rest the hover buttons take no space', () => {
  assert.match(app, /if \(s\.cls === 'input' && a\.waitingFor\) \{/);
  const host = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'panelHost.ts'), 'utf8');
  assert.match(host, /mem: mem\[a\.pid\], waitingFor: a\.waitingFor, statusUpdatedAt: a\.statusUpdatedAt \}/, 'main sends it to the renderer');
  const css = fs.readFileSync('renderer/theme.css', 'utf8');
  assert.match(css, /\.prow2:not\(:hover\):not\(:focus-within\) \.runact:not\(\.has\) \{ display: none; \}/);
  assert.match(css, /body\.light \.zsplit \.pane\.termcard\.panefocus \{ border-color: var\(--accent\);/, '#24 (2c) light-theme focus border');
});
