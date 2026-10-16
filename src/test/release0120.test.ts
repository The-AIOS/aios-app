/** 0.12.0 reviewer batch 2 — the App-only findings. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';

const app = () => fs.readFileSync('renderer/app.js', 'utf8');
const main = () => fs.readFileSync('src/main/main.ts', 'utf8');

test('a TYPED session name is checked against running sessions and open tabs, like a suggested one', () => {
  /* Typing `buddai` while buddai was live started a second buddai the bus cannot tell apart. */
  assert.match(app(), /const name = await window\.glassShell\.askUnique\(wanted, panesNow\)/);
  assert.match(main(), /ipcMain\.handle\('ask:unique', \(_e, name: unknown, panes\?: unknown\) => uniqueName\(String\(name \?\? ''\), liveNames\(panes\)\)\)/);
  assert.match(main(), /\.\.\.aios\.listRunningAgents\(\)\.map\(\(a\) => a\.name\),/, 'live = the registry …');
  assert.match(app(), /function openPaneNames\(\) \{ return \[\.\.\.panes\.values\(\)\]\.filter\(\(p\) => !p\.exited && p\.name\)/, '… and this window\'s open tabs');
});

test('the hidden-waiting note logs the PROJECT, never the full path — the trail is attached to feedback', () => {
  const host = fs.readFileSync('src/main/panelHost.ts', 'utf8');
  const i = host.indexOf('private noteHiddenWaiting');
  const body = host.slice(i, host.indexOf('\n  }\n', i));
  assert.doesNotMatch(body, /\$\{a\.cwd/, 'no raw cwd in the line');
  assert.match(body, /project \$\{projOf\(a\.cwd \|\| ''\) \|\| '\?'\}/);
});
