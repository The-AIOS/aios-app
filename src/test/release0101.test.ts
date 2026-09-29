/**
 * 0.10.1 — the two fixes that ride with the contributor PRs (#40 microphone entitlement, #39
 * reveal + fs:read gate).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { webPermissionAllowed, DENIED_WEB_PERMISSIONS } from '../main/webPermissions';

test('web content cannot use the microphone, camera or screen, now that the App may reach them (#40)', () => {
  for (const p of ['media', 'display-capture', 'geolocation', 'hid', 'serial', 'usb', 'midiSysex'])
    assert.equal(webPermissionAllowed(p), false, `${p} is denied to web content`);
  for (const p of ['clipboard-sanitized-write', 'fullscreen', 'notifications'])
    assert.equal(webPermissionAllowed(p), true, `${p} keeps Electron's behaviour — the interface relies on it`);
  assert.ok(DENIED_WEB_PERMISSIONS.has('media'));
});

test('the policy is installed on the default session AND every session created later (browser panes)', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'main.ts'), 'utf8');
  assert.match(main, /app\.on\('session-created', \(s\) => installWebPermissionPolicy\(s\)\);/);
  assert.match(main, /installWebPermissionPolicy\(session\.defaultSession\);/);
  const pol = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'webPermissions.ts'), 'utf8');
  assert.match(pol, /setPermissionRequestHandler/, 'the prompted path');
  assert.match(pol, /setPermissionCheckHandler/, 'and the synchronous check path');
});

const app = fs.readFileSync('renderer/app.js', 'utf8');
const dpSrc = /function droppedPaths\(ev\) \{[\s\S]*?\n\}/.exec(app)![0];

test('a drop says where its paths came from; only real desktop files are "files"', () => {
  const run = new Function('ev', 'window', 'fileUrlToPath', `${dpSrc}; return droppedPaths(ev);`) as
    (ev: object, w: object, f: (u: string) => string) => string[] & { source?: string };
  const win = { glassShell: { pathForFile: (f: { p: string }) => f.p } };
  const id = (u: string) => u;
  const dt = (data: Record<string, string>, files: object[] = []) => ({ dataTransfer: { getData: (k: string) => data[k] || '', files } });
  assert.equal(run(dt({}, [{ p: '/Users/x/Desktop/a.png' }]), win, id).source, 'files');
  assert.equal(run(dt({ 'text/plain': 'hello world' }), win, id).source, 'text', 'dropped TEXT is not a file');
  assert.equal(run(dt({ 'text/uri-list': 'https://x.com/a.png' }), win, id).source, 'text', 'a browser link or image URL is not a file');
  assert.equal(run(dt({ 'application/x-aios-path': '/v/n.md' }), win, id).source, 'own');
});

test('the editor zone: text is one message, a Finder file is granted and shown, a Finder folder is added', () => {
  assert.match(app, /if \(source === 'text'\) \{[\s\S]{0,300}toast\(t\('drop\.textNotFile'\)\); return; \}/, 'dropped text → one toast, not one per line');
  assert.match(app, /if \(source === 'files'\) \{[\s\S]{0,400}addFolderPath\(dropped\)[\s\S]{0,900}grantDroppedFiles/, 'folders still become workspace folders; files are granted');
  assert.match(app, /void onPath\(paths, draggedIsDir\(ev\), \{ \.\.\.opts, source: paths\.source, files: paths\.files \}\);/);
});
