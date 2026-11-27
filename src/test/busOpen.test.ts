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

test('runOpen decides with the shared module, on the framework root only, prepared once at bus start', () => {
  assert.match(runOpen, /decideOpen\(\{ body, seenAgoMs: seen\.seenAgoMs, presentAtStart: seen\.atStart, nowMs: now, roots: openRoots,/);
  const prep = between(bus, 'function prepareOpenRoots(', '\n}');
  assert.match(prep, /prepareRoots\(\[fw\], os\.homedir\(\)\)/, 'one root: the framework root');
  assert.doesNotMatch(prep, /workspaceFolders|dropped|grant/i, 'workspace folders and dropped files are not roots for an agent (their lists are session-writable)');
  assert.match(prep, /without vault\/ and plugins\/aios\/\); it is read when the App starts, so restart it/, 'the dead letter says why, and that a restart re-reads it');
  const init = between(bus, 'export function initCommandBus(', '\n}');
  assert.match(init, /prepareOpenRoots\(\);/, 'prepared when the bus starts, not per request');
  assert.match(runOpen, /d\.why === 'unavailable' && openOff/, 'open off answers at check 8, after the flood and rate counting');
  assert.doesNotMatch(runOpen.slice(0, runOpen.indexOf('decideOpen(')), /markUndelivered/, 'nothing is refused before the decision counts it');
});

test('runOpen counts every decision except a too-old one, refused ones included, before acting on it', () => {
  assert.match(runOpen, /if \(d\.do === 'open' \|\| d\.counted\) decidedOpens = rememberDecided\(/);
  const remember = runOpen.indexOf('rememberDecided(');
  const refuse = runOpen.indexOf("if (d.do === 'refuse')");
  assert.ok(remember > 0 && refuse > remember);
});

test('the content shown is read by main, from the file the decision checked, images and PDFs as bytes', () => {
  assert.match(runOpen, /readChecked\(d\.path, d\.identity, \{ roots: openRoots, asBytes: asset \}\)/);
  assert.match(runOpen, /emit\(w, 'openFile', \{[^}]*bus: true[^}]*\n?[^}]*content: asset \? undefined : String\(r\.content\), bytes: asset \? new Uint8Array/);
  assert.match(viewer, /const roBlob = ro && o\.asset && o\.bytes \? new Blob\(\[o\.bytes\]/);
  assert.match(viewer, /img\.src = ro \? \(roBlob \? blobUrl\(img, roBlob\) : ''\) : fileUrl\(file\.path\);/, 'a snapshot image only from its bytes, never by its path');
  assert.match(app, /case 'openFile':[\s\S]{0,200}asset: m\.asset, bytes: m\.bytes, snap: m\.snap \}/, 'the intent forwards the bytes and the re-check token');
  const csp = (fs.readFileSync('renderer/index.html', 'utf8').match(/http-equiv="Content-Security-Policy" content="([^"]+)"/) ?? [])[1] ?? '';
  assert.match(csp, /img-src [^;]*\bblob:/, 'the page allows the blob images it makes');
  assert.doesNotMatch(csp, /frame-src [^;]*\bblob:/, 'and no blob frames: a PDF a session asks for is not shown');
  assert.match(runOpen, /if \(\/\\\.pdf\$\/i\.test\(d\.path\)\) \{ markUndelivered\(heldPath, req, 'open refused \(unreadable\)/);
  assert.match(runOpen, /if \(!w \|\| w\.isDestroyed\(\)\) \{ markUndelivered\(/, 'no window is a dead letter, not a silent success');
});

test('nothing a session asked for is handed to the desktop, and the window is never raised', () => {
  for (const banned of ['shell.', 'openExternal', 'openPath', 'revealInOS', 'showItemInFolder', '.show()', '.focus()', 'moveTop']) {
    assert.ok(!runOpen.includes(banned), `runOpen must not use ${banned}`);
  }
});

test('the age is this App\'s own clock from first sight, never the file\'s timestamps', () => {
  assert.doesNotMatch(runOpen, /mtime|statSync/);
  const consume = between(bus, 'function consume(', '\n}');
  assert.match(consume, /firstSeen\.set\(fsPath, \{ ino, at: Date\.now\(\) \}\)/);
  assert.match(consume, /if \(draining \|\| recovered\) presentAtStart\.add\(fsPath\);/);
  const drain = between(bus, 'draining = true;', 'draining = false;');
  assert.match(drain, /if \(f\.endsWith\('\.json'\)\) consume\(getWin, path\.join\(dir, f\)\);/, 'a request already waiting at startup is marked');
});

test('a flood is dropped without a dead letter for each request', () => {
  assert.match(runOpen, /if \(d\.why === 'flood'\) \{ noteFlood\(heldPath, body\); return; \}/);
  const flood = between(bus, 'function noteFlood(', "\nipcMain.handle('bus:imageBytes'");
  assert.doesNotMatch(flood, /markUndelivered\(/, 'no request file becomes the notice: a session may reuse its file name');
  assert.match(flood, /try \{ fs\.unlinkSync\(heldPath\); \}/, 'each dropped request goes at once');
  assert.match(flood, /if \(!floodTimer\) floodTimer = setTimeout\(flushFlood, 60_000\);/, 'one notice, at the end of the minute');
  assert.match(flood, /path\.join\(last\.dir, `open-flood-\$\{Date\.now\(\)\}-\$\{process\.pid\}\.json\.undelivered`\)/, 'under a name of its own');
  assert.match(flood, /\$\{n\} open request\(s\) dropped in the last minute/, 'with the full count');
  assert.match(bus, /app\.on\('before-quit', flushFlood\);/, 'and on quit, rather than lost');
  assert.match(flood, /floodLast = null; floodDropped = 0;\s*if \(!last \|\| !n\) return;/, 'state is reset first, so a second quit or a late timer writes nothing');
});

test('a local image in a session\'s note is shown only if it passes the note\'s own checks, from its checked bytes', () => {
  const h = between(bus, "ipcMain.handle('bus:imageBytes'", '\n});');
  assert.match(h, /path\.posix\.normalize\(/, '.. is applied as text first, as a browser would');
  assert.match(h, /decideOpen\(/);
  assert.match(h, /readChecked\(d\.path, d\.identity, \{ roots: openRoots, asBytes: true, limit: IMAGE_LIMIT \}\)/, 'a smaller bound for note images');
  assert.match(h, /if \(imageReads\.length >= IMAGE_RATE \|\| imageReads\.reduce\(\(n, r\) => n \+ r\.bytes, 0\) >= IMAGE_BYTES_PER_MINUTE\) return null;/, 'a rate of its own, in reads and in bytes');
  assert.match(app, /if \(holds\.by\.size >= IMAGE_PER_NOTE\) \{ deny\(\); return; \}/, 'each path asked once, at most 50 a note');
  assert.match(app, /const blobUrl = \(img, blob\) => \{ const u = URL\.createObjectURL\(blob\); img\.addEventListener\('load', \(\) => URL\.revokeObjectURL\(u\)/, 'object URLs are revoked');
  assert.match(app, /function holdSnapshotImage\(img, s, dir, holds\)/);
  assert.match(viewer, /if \(ro\) \{ holdSnapshotImage\(img, s, dir, holds\); continue; \}/);
  const hold = between(app, 'function holdSnapshotImage(', '\n}');
  assert.ok(hold.indexOf("img.removeAttribute('src')") < hold.indexOf('busImageBytes'), 'no source until main sends the bytes');
  assert.doesNotMatch(hold, /fileUrl\(/, 'never by its path');
});

test('a snapshot is never saved or restored across a restart', () => {
  assert.match(app, /p\.kind === 'view' && !p\.readOnly && typeof p\.path === 'string'/);
});

test('adopted and recovered holds are late by definition for open', () => {
  assert.match(bus, /seen = \{ seenAgoMs: Infinity, atStart: true \}\): void \{/);
  assert.match(bus, /recoveredClaims\.add\(back\);[^\n]*\n\s*consume\(win, back\);/);
  const consume = between(bus, 'function consume(', '\n}');
  assert.match(consume, /prior\.ino !== ino/, 'the same name written again later is a new request');
});

test('a session\'s pane is a snapshot: its text comes from main, it never reads the path, never reloads, never saves', () => {
  assert.match(viewer, /const ro = !!o\.bus;/);
  assert.match(viewer, /const file = ro\s*\? \(typeof o\.content === 'string'/, 'the snapshot text is what main read');
  assert.match(viewer, /const editable = !ro && /);
  assert.match(viewer, /if \(ro \|\| paneObj\.dirty/, 'a disk change is ignored');
  assert.match(viewer, /if \(!ro\) \{\s*void window\.glassShell\.fsWatchFile/, 'the path is not even watched');
  assert.match(viewer, /if \(ro\) \{ editor\.setReadOnly\?\.\(true\);/, 'the source view cannot be typed into');
  assert.match(app, /if \(ta\.readOnly\) return;   \/\/ a session's snapshot: Tab and ⌘S change nothing/, 'nor changed by Tab, nor saved by ⌘S');
  assert.match(viewer, /const save = \(content, prefer\) => \(ro \? Promise\.resolve\(null\)/, 'a save does nothing');
  assert.match(viewer, /paneObj\.flushSave = \(quitting\) => \{\s*if \(ro\) return;/, 'nor the save on close or quit');
  assert.match(viewer, /\}, ro \? null : file\.path\);/, 'and git is not asked about the file on disk');
  assert.match(viewer, /if \(!ro\) noteRecentFile\(file\.path\);/, 'nor added to the operator\'s recent files');
  assert.match(viewer, /if \(ro\) \{ box\.disabled = true; return; \}/, 'task boxes do not write');
  assert.match(app, /wrap\.setReadOnly = \(on\) => \{ ta\.readOnly = !!on;/);
});

test('the snapshot says so on screen, and "Open to edit" reopens it as the operator\'s own', () => {
  assert.match(viewer, /t\('viewer\.readOnlyBadge', \{ by:/);
  assert.match(viewer, /window\.glassShell\.busRecheckSnapshot\?\.\(o\.snap \|\| ''\)[\s\S]{0,160}if \(!r \|\| !r\.real\) \{ toast\([^\n]*\); return; \}\s*closePane\(id\); void openViewer\(r\.real\);/, 'the real file is checked again before it opens for editing');
  const re = between(bus, "ipcMain.handle('bus:recheckSnapshot'", '\n});');
  assert.match(re, /readChecked\(s\.path, s\.identity, \{ roots: openRoots, asBytes: s\.asset \}\)\.ok \? \{ real: s\.path \} : \{ reason: 'changed' \}/);
  assert.match(re, /if \(!s\) return \{ reason: 'old' \};/, 'a forgotten token says so, it is not "changed"');
  assert.match(viewer, /if \(HTML_EXT\.test\(name\) && !ro\)/, 'no PNG render of an HTML file a session asked for');
  assert.match(viewer, /if \(!ro\) head\.appendChild\(rev\);/, 'no reveal button on a snapshot');
  for (const loc of ['en', 'es', 'fr', 'el', 'pt-br']) {
    const j = JSON.parse(fs.readFileSync(`src/i18n/locales/${loc}.json`, 'utf8')) as Record<string, string>;
    for (const k of ['viewer.readOnlyBadge', 'viewer.openToEdit', 'viewer.openToEditTip', 'viewer.imageHeld', 'viewer.openedBehind', 'viewer.changedSinceSnapshot', 'viewer.snapshotTooOld']) {
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
  assert.match(viewer, /const behind = ro && openBehind\(o\);/, 'typing anywhere in the App counts, and the follow setting does not apply');
  assert.match(app, /const openBehind = \(o\) => !!\(o && \(o\.background \|\| Date\.now\(\) - lastKeyAt < 8000\)\);/);
});

test('the read gate lives in the shared package, and the App re-exports it unchanged', () => {
  assert.match(fs.readFileSync('src/main/preview.ts', 'utf8'), /from '@the-aios\/core\/readClass'/);
});
