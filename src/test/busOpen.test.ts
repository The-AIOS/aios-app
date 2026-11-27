/**
 * The bus's `open` verb (contract 5) in the App: the wiring around the shared decision.
 *
 * The decision itself (@the-aios/core/openRequest) is tested in the package against the
 * framework's conformance fixture. What is left here is the App's part, which cannot be imported
 * (the dispatcher and the renderer run inside Electron), so these read the source and assert the
 * seams: the verb reaches the shared decision, the content shown is read by main from the file
 * that was checked, the pane a session opened is a read-only snapshot that never reloads, and
 * nothing a session asked for is ever handed to the desktop.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { normalizeVerb } from '@the-aios/core/busVerbs';

const bus = fs.readFileSync('src/main/commandBus.ts', 'utf8');
const app = fs.readFileSync('renderer/app.js', 'utf8');
const between = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from); const b = src.indexOf(to, a + from.length);
  assert.ok(a >= 0 && b > a, `markers not found: ${from} … ${to}`);
  return src.slice(a, b);
};
const runOpen = between(bus, 'function runOpen(', '\nfunction noteFlood(');
const viewer = between(app, 'async function openViewer(p, o = {}) {', '\n/* Vault-note sanitizer.');

test('open is a verb', () => {
  assert.equal(normalizeVerb('open'), 'open');
  assert.equal(normalizeVerb(' OPEN '), 'open');
});

test('the dispatcher sends open to runOpen before the ambiguous-name rule (the name is who asks, not a target)', () => {
  const ri = between(bus, 'function runImmediate(', '\nfunction claim(');
  const open = ri.indexOf("if (req.action === 'open') { runOpen(");
  const clash = ri.indexOf('ambiguousNames(req.name)');
  assert.ok(open > 0 && clash > open);
  assert.match(ri, /implements spawn, kill, send, `\s*\+ `resume and open/, 'the unknown-verb dead letter lists open');
});

test('runOpen decides with the shared module, on the framework root and the workspace folders only', () => {
  assert.match(runOpen, /decideOpen\(\{ body, seenAgoMs: seen\.seenAgoMs, presentAtStart: seen\.atStart,/);
  const roots = between(bus, 'function busOpenRoots(', '\n}');
  assert.match(roots, /aios\.frameworkRoot\(\), \.\.\.aios\.workspaceFolders\(\)/);
  assert.doesNotMatch(roots, /dropped|grant/i, 'files the operator dropped are not a root for an agent');
});

test('runOpen counts every decision, refused ones included, before acting on it', () => {
  const remember = runOpen.indexOf('rememberDecided(');
  const refuse = runOpen.indexOf("if (d.do === 'refuse')");
  assert.ok(remember > 0 && refuse > remember);
});

test('the content shown is read by main, from the file the decision checked', () => {
  assert.match(runOpen, /readChecked\(d\.path, d\.identity, \{ roots, home \}\)/);
  assert.match(runOpen, /emit\(win\(\), 'openFile', \{[^}]*bus: true[^}]*content[^}]*\}\)/);
});

test('nothing a session asked for is handed to the desktop, and the window is never raised', () => {
  for (const banned of ['shell.', 'openExternal', 'openPath', 'revealInOS', 'showItemInFolder', '.show()', '.focus()', 'moveTop']) {
    assert.ok(!runOpen.includes(banned), `runOpen must not use ${banned}`);
  }
});

test('the age is this App\'s own clock from first sight, never the file\'s timestamps', () => {
  assert.doesNotMatch(runOpen, /mtime|statSync/);
  const consume = between(bus, 'function consume(', '\n}');
  assert.match(consume, /firstSeen\.set\(fsPath, Date\.now\(\)\)/);
  assert.match(bus, /presentAtStart\.add\(path\.join\(dir, f\)\); consume\(getWin, path\.join\(dir, f\)\)/, 'a request already waiting at startup is marked');
});

test('a flood is dropped without a dead letter for each request', () => {
  assert.match(runOpen, /if \(d\.why === 'flood'\) \{ noteFlood\(heldPath, req\); return; \}/);
  const flood = between(bus, 'function noteFlood(', "\nipcMain.handle('bus:imageAllowed'");
  assert.equal((flood.match(/markUndelivered\(/g) ?? []).length, 1, 'one dead letter a minute, not one per request');
});

test('a local image in a session\'s note is shown only if it passes the note\'s own checks', () => {
  const h = between(bus, "ipcMain.handle('bus:imageAllowed'", '\n});');
  assert.match(h, /decideOpen\(/);
  assert.match(app, /function holdSnapshotImage\(img, s, dir\)/);
  assert.match(viewer, /if \(ro\) \{ holdSnapshotImage\(img, s, dir\); continue; \}/);
  const hold = between(app, 'function holdSnapshotImage(', '\n}');
  assert.ok(hold.indexOf("img.removeAttribute('src')") < hold.indexOf('busImageAllowed'), 'no source until main says yes');
});

test('a session\'s pane is a snapshot: its text comes from main, it never reads the path, never reloads, never saves', () => {
  assert.match(viewer, /const ro = !!o\.bus;/);
  assert.match(viewer, /const file = ro\s*\? \(typeof o\.content === 'string'/, 'the snapshot text is what main read');
  assert.match(viewer, /const editable = !ro && /);
  assert.match(viewer, /if \(ro \|\| paneObj\.dirty/, 'a disk change is ignored');
  assert.match(viewer, /if \(!ro\) \{\s*void window\.glassShell\.fsWatchFile/, 'the path is not even watched');
  assert.match(viewer, /if \(ro\) \{ editor\.setReadOnly\?\.\(true\);/, 'the source view cannot be typed into');
  assert.match(viewer, /if \(ro\) \{ box\.disabled = true; return; \}/, 'task boxes do not write');
  assert.match(app, /wrap\.setReadOnly = \(on\) => \{ ta\.readOnly = !!on;/);
});

test('the snapshot says so on screen, and "Open to edit" reopens it as the operator\'s own', () => {
  assert.match(viewer, /t\('viewer\.readOnlyBadge', \{ by:/);
  assert.match(viewer, /edit\.addEventListener\('click', \(\) => \{ closePane\(id\); void openViewer\(file\.path\); \}\);/);
  assert.match(viewer, /if \(HTML_EXT\.test\(name\) && !ro\)/, 'no PNG render of an HTML file a session asked for');
  assert.match(viewer, /if \(!ro\) head\.appendChild\(rev\);/, 'no reveal button on a snapshot');
  for (const loc of ['en', 'es', 'fr', 'el', 'pt-br']) {
    const j = JSON.parse(fs.readFileSync(`src/i18n/locales/${loc}.json`, 'utf8')) as Record<string, string>;
    for (const k of ['viewer.readOnlyBadge', 'viewer.openToEdit', 'viewer.openToEditTip', 'viewer.imageHeld', 'viewer.openedBehind']) {
      assert.ok(j[k] && j[k].length > 3, `${loc} has ${k}`);
    }
    assert.ok(j['viewer.readOnlyBadge'].includes('{by}') && j['viewer.openedBehind'].includes('{by}'), `${loc} names who opened it`);
  }
});

test('a file a session asked for that the viewer cannot show is never revealed in the file manager', () => {
  const bus1 = viewer.indexOf('if (file.unreadable && o.bus)');
  const reveal = viewer.indexOf('window.glassShell.revealInOS(file.path)');
  assert.ok(bus1 > 0 && reveal > bus1);
});

test('in front unless the operator is typing; behind, the tab is marked and a notice names who asked', () => {
  assert.match(runOpen, /const typing = \[\.\.\.composing\.values\(\)\]\.some\(\(rec\) => operatorComposing\(rec, now\)\);/);
  assert.match(viewer, /if \(behind\) \{ markActivity\(id\); toast\(t\('viewer\.openedBehind'/);
});

test('the read gate lives in the shared package, and the App re-exports it unchanged', () => {
  assert.match(fs.readFileSync('src/main/preview.ts', 'utf8'), /from '@the-aios\/core\/readClass'/);
});
