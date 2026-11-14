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
  (s) => { const h = handler(s); const read = h.indexOf('readFileSync(abs'), dec = h.indexOf('decideSave(base, mine, disk'), conf = h.indexOf("if ('conflict' in d) return"), write = h.indexOf('writeFileSync(tmp'); return read > 0 && read < dec && dec < conf && conf < write; },
  (s) => s.replace("if ('conflict' in d) return { ok: false, conflict: true, disk };", ''));

guarded('the viewer saves through fs:saveMerged with its base, never with a plain write to the note', app,
  (s) => { const v = viewerSave(s); return /fsSaveMerged\(file\.path, base, content, prefer\)/.test(v) && !/fsWrite\(file\.path/.test(v); },
  (s) => s.replace('window.glassShell.fsSaveMerged(file.path, base, content, prefer)', 'window.glassShell.fsWrite(file.path, content)'));

guarded('while a conflict is open, autosave writes only the side copy, never the note; ⌘S tries the note again', app,
  (s) => /if \(paneObj\.conflict && !explicit\) \{ await keepSideCopy\(content\); return; \}/.test(viewerSave(s)),
  (s) => s.replace('if (paneObj.conflict && !explicit) { await keepSideCopy(content); return; }', ''));

guarded('every mode paints from the text on screen, so switching Rendered/Edit never drops an unsaved edit (review #1, #3)', app,
  (s) => /buildCodeEditor\(toEditor\(file\.content\)/.test(s) && /onInput: \(v\) => \{ file\.content = toDisk\(v\);/.test(s),
  (s) => s.replace('onInput: (v) => { file.content = toDisk(v);', 'onInput: (v) => {'));

guarded('a CRLF note is saved in CRLF: the editor\'s LF text is converted back before it is compared or written (review #6)', app,
  (s) => /const after = \(v, explicit\) => save\(toDisk\(v\), explicit\)/.test(s) && /const shownNow = \(\) => \(editorRef \? toDisk\(editorRef\.value\(\)\) : file\.content\);/.test(s),
  (s) => s.replace('save(toDisk(v), explicit)', 'save(v, explicit)'));

guarded('an open note that changed on disk reloads only when nothing is unsaved', app,
  (s) => /paneObj\.onDiskMaybeChanged = async \(\) => \{\n\s*if \(paneObj\.dirty \|\| paneObj\.conflict/.test(s) && /p\.onDiskMaybeChanged\(\)/.test(s),
  (s) => s.replace('if (paneObj.dirty || paneObj.conflict || !editable) return;', 'if (!editable) return;'));

test('a checkbox ticked in Rendered mode is counted on the text on screen and saves through the same path', () => {
  const box = app.slice(app.indexOf('// live task checkboxes'), app.indexOf('wrap.appendChild(md);', app.indexOf('// live task checkboxes')));
  assert.match(box, /const updated = file\.content\.replace\(/);
  assert.match(box, /file\.content = updated; setDirty\(true\); paint\(\);\s*void save\(updated\);/);
  assert.doesNotMatch(box, /fsWrite\(/);
});

test('"Keep my changes" keeps the agent\'s other changes: mine win only on the clashing lines (review #4)', () => {
  const mine = note.replace('ship 0.15.2', 'ship 0.15.2 MINE');
  const disk = note.replace('ship 0.15.2', 'ship 0.15.2 THEIRS') + 'agent appended\n';
  assert.deepEqual(decideSave(note, mine, disk), { conflict: true }, 'without a choice, it asks');
  const d = decideSave(note, mine, disk, 'mine');
  assert.ok('write' in d && d.write.includes('ship 0.15.2 MINE') && !d.write.includes('THEIRS') && d.write.includes('agent appended'));
  assert.ok(!agentLineSurvives((b, m) => ({ write: m })), 'negative control: a plain overwrite drops the agent\'s lines');
  assert.match(viewerSave(app) + app.slice(app.indexOf('async function askConflict('), app.indexOf('async function askConflict(') + 900), /if \(pick === 'mine'\) \{ await save\(null, true, 'mine'\); return; \}/, 'the dialog\'s answer goes through the same merge, not fsWrite');
});

test('both inserted at one point, one beginning with the other: the shared lines are written once (review #7)', () => {
  assert.deepEqual(merge3('x\n', 'x\nfoo\nbar\n', 'x\nfoo\n'), { ok: true, text: 'x\nfoo\nbar\n' });
  assert.deepEqual(merge3('x\n', 'x\nfoo\n', 'x\nfoo\nbar\n'), { ok: true, text: 'x\nfoo\nbar\n' });
  assert.deepEqual(merge3('x\n', 'x\nmine\n', 'x\nagent\n'), { ok: true, text: 'x\nagent\nmine\n' }, 'unrelated insertions: both, the disk\'s first');
});

/* The caret, when an agent's write is merged into the open note (review #5): mapCaret, run from the real source. */
const caretFn = (src: string) => new Function(src.slice(src.indexOf('function mapCaret('), src.indexOf('\nfunction buildCodeEditor(')) + '\nreturn mapCaret;')() as (o: string, n: string, p: number) => number;
guarded('the caret stays on the operator\'s line when an agent changes text above AND below it in one write', app,
  (s) => {
    const mapCaret = caretFn(s);
    const old = '- [ ] task a\n- [ ] task b\nmy line here\nend\n';
    const neu = '- [x] task a done\n- [ ] task b\nmy line here\nend\n## Session\nagent wrote\n';
    const pos = old.indexOf('my line here') + 7;   // after "my line"
    const to = mapCaret(old, neu, pos);
    return neu.slice(to - 7, to) === 'my line' && mapCaret(old, neu, 3) === 3 && mapCaret('a\nb\n', 'a\nb\nc\n', 3) === 3;
  },
  (s) => s.replace("  else {\n    const hit = N.indexOf(O[line], pre);\n    to = hit >= 0 && hit < N.length - suf ? hit : pre;\n  }", '  else to = line + (N.length - O.length);'));

test('the side copy\'s remover deletes only a side copy, never a note', () => {
  const h = main.slice(main.indexOf("ipcMain.handle('fs:removeSideCopy'"), main.indexOf('\n});\n', main.indexOf("ipcMain.handle('fs:removeSideCopy'")));
  const re = new RegExp(/test\(path\.basename\(abs\)\)/.test(h) ? / \(unsaved edits\)(\.[^.\\/]+)?$/ : /^$/);
  assert.ok(re.test('2026-11-13 (unsaved edits).md') && !re.test('2026-11-13.md') && !re.test('unsaved edits.md'));
  assert.match(h, /if \(!abs \|\| !\/ \\\(unsaved edits\\\)/, 'the name is checked before unlink');
  assert.ok(h.indexOf('unlinkSync') > h.indexOf('(unsaved edits'));
});
