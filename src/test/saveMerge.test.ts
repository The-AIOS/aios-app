/**
 * #159: saving a note can erase what an agent just wrote to it. The viewer now saves against the disk as it is NOW
 * (src/core/saveMerge.ts, the fs:saveMerged handler in main, and save() in openViewer). Each behaviour check is paired with
 * a negative control: the same check against a deliberately broken version must fail, or the check proves nothing.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { merge3, decideSave, type SaveDecision } from '../core/saveMerge';

const note = ['# 2026-11-13', '', '## Today', '- [ ] ship 0.15.2', '', '## Agents can handle', '- 🤖 ingest', ''].join('\n');

/** The incident: an agent appends a section while the operator edits another line. Both must survive the save. */
function agentLineSurvives(decide: (base: string, mine: string, disk: string | null) => SaveDecision): boolean {
  const mine = note.replace('- [ ] ship 0.15.2', '- [x] ship 0.15.2');
  const disk = note + '\n## Session — 18:42\n<!-- close-session -->\n';
  const d = decide(note, mine, disk);
  return 'write' in d && d.write.includes('## Session — 18:42') && d.write.includes('- [x] ship 0.15.2');
}

test('an agent\'s section survives the operator\'s save, and so does the operator\'s edit (the #159 incident)', () => {
  assert.ok(agentLineSurvives(decideSave), 'the real decision keeps both');
  const naive = (_b: string, m: string): SaveDecision => ({ write: m });   // the old behaviour: write my copy, whatever is on disk
  assert.equal(agentLineSurvives(naive), false, 'negative control: the old unconditional save fails this check');
});

test('unchanged disk: the editor\'s text is written as is', () => {
  assert.deepEqual(decideSave(note, note + 'x', note), { write: note + 'x' });
  assert.deepEqual(decideSave(note, 'gone?', null), { write: 'gone?' }, 'a missing file is written, as before');
});

test('only the disk changed: the disk is kept (nothing of mine to write over it)', () => {
  const disk = note + 'agent line\n';
  assert.deepEqual(decideSave(note, note, disk), { write: disk });
});

test('both changed the same line: a conflict, nothing to write', () => {
  const mine = note.replace('ship 0.15.2', 'ship 0.15.2 today');
  const disk = note.replace('ship 0.15.2', 'ship 0.15.2 tomorrow');
  assert.deepEqual(decideSave(note, mine, disk), { conflict: true });
  const deleted = note.replace('- [ ] ship 0.15.2\n', '');
  assert.deepEqual(decideSave(note, mine, deleted), { conflict: true }, 'an edit against a deletion of the same line also asks');
});

test('both made the identical change: applied once, no conflict', () => {
  const both = note.replace('- [ ]', '- [x]');
  assert.deepEqual(merge3(note, both, both), { ok: true, text: both });
  const mine = both.replace('# 2026-11-13', '# Friday');
  const r = merge3(note, mine, both + 'tail\n');
  assert.ok(r.ok && r.text === mine + 'tail\n', 'the shared change once, plus each side\'s own');
});

test('both inserted at the same point: both kept, the disk\'s lines first', () => {
  const mine = note + 'my new line';
  const disk = note + 'agent line\n';
  const r = merge3(note, mine, disk);
  assert.ok(r.ok, 'no question for two insertions');
  assert.ok(r.ok && r.text.indexOf('agent line') < r.text.indexOf('my new line') && r.text.includes('my new line'));
});

test('edits at both ends of a note merge, and line endings are kept as they were', () => {
  const crlf = note.split('\n').join('\r\n');
  const mine = crlf.replace('# 2026-11-13', '# Friday');
  const disk = crlf + '\r\nappended';
  const r = merge3(crlf, mine, disk);
  assert.ok(r.ok && r.text === mine + '\r\nappended');
});

test('notes too different to diff cheaply ask instead of guessing', () => {
  const big = (k: string) => Array.from({ length: 2500 }, (_, i) => `${k}${i}`).join('\n');
  const base = big('a');
  assert.deepEqual(decideSave(base, big('b'), big('c')), { conflict: true });
});

/* The wiring: main decides before it writes, and the viewer's save goes through it. */
const main = fs.readFileSync('src/main/main.ts', 'utf8');
const app = fs.readFileSync('renderer/app.js', 'utf8');
const handler = (src: string) => src.slice(src.indexOf("ipcMain.handle('fs:saveMerged'"), src.indexOf('\n});\n', src.indexOf("ipcMain.handle('fs:saveMerged'")));
const viewerSave = (src: string) => src.slice(src.indexOf('async function saveNow('), src.indexOf('\n  }\n', src.indexOf('async function saveNow(')));

function guarded(name: string, src: string, check: (s: string) => boolean, breakIt: (s: string) => string): void {
  test(name, () => {
    assert.ok(check(src), `${name}: the check does not hold on the real source`);
    const broken = breakIt(src);
    assert.notEqual(broken, src, `${name}: the negative control changed nothing`);
    assert.equal(check(broken), false, `${name}: the check still passes on a broken copy — it proves nothing`);
  });
}

guarded('main reads the disk and decides BEFORE writing; a conflict writes nothing', main,
  (s) => { const h = handler(s); const read = h.indexOf('readFileSync(abs'), dec = h.indexOf('decideSave(base, mine, disk)'), conf = h.indexOf("if ('conflict' in d) return"), write = h.indexOf('writeFileSync(tmp'); return read > 0 && read < dec && dec < conf && conf < write; },
  (s) => s.replace("if ('conflict' in d) return { ok: false, conflict: true, disk };", ''));

guarded('the viewer saves through fs:saveMerged with its base, never with a plain write', app,
  (s) => { const v = viewerSave(s); return /fsSaveMerged\(file\.path, base, content\)/.test(v) && !/fsWrite\(/.test(v); },
  (s) => s.replace('window.glassShell.fsSaveMerged(file.path, base, content)', 'window.glassShell.fsWrite(file.path, content)'));

guarded('while a conflict is open, autosave writes nothing; only an explicit save (⌘S) tries again', app,
  (s) => /if \(paneObj\.conflict && !explicit\) return;/.test(viewerSave(s)),
  (s) => s.replace('if (paneObj.conflict && !explicit) return;', ''));

guarded('an open note that changed on disk reloads only when nothing is unsaved', app,
  (s) => /paneObj\.onDiskMaybeChanged = async \(\) => \{\n\s*if \(paneObj\.dirty \|\| paneObj\.conflict/.test(s) && /p\.onDiskMaybeChanged\(\)/.test(s),
  (s) => s.replace('if (paneObj.dirty || paneObj.conflict || !editable) return;', 'if (!editable) return;'));

test('a checkbox ticked in Rendered mode saves through the same path', () => {
  const box = app.slice(app.indexOf('// live task checkboxes'), app.indexOf('wrap.appendChild(md);', app.indexOf('// live task checkboxes')));
  assert.match(box, /void save\(updated, true\);/);
  assert.doesNotMatch(box, /fsWrite\(/);
});
