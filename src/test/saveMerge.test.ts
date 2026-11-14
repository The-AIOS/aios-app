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

test('line endings: compared in LF, written back CRLF only when the note is CRLF throughout (review #6, second pass #4)', () => {
  const crlf = note.split('\n').join('\r\n');
  const editor = note.replace('# 2026-11-13', '# Friday');                   // the textarea speaks LF
  const d1 = decideSave(crlf, editor, crlf + 'appended\r\n');
  assert.ok('write' in d1 && d1.write === editor.split('\n').join('\r\n') + 'appended\r\n', 'a CRLF note stays CRLF, and an LF editor text is no conflict');
  const mixed = 'a\r\nb\nc\r\n';
  assert.deepEqual(decideSave(mixed, 'a\nB\nc\n', mixed), { write: 'a\nB\nc\n' }, 'a mixed note is saved in LF, as the editor always did');
  const d2 = decideSave(crlf, editor, note + 'x\n');                         // an agent rewrote it as LF
  assert.ok('write' in d2 && !d2.write.includes('\r'), 'the disk is LF now: so is what is written');
});

test('notes too different to diff cheaply ask instead of guessing', () => {
  const big = (k: string) => Array.from({ length: 2500 }, (_, i) => `${k}${i}`).join('\n');
  const base = big('a');
  assert.deepEqual(decideSave(base, big('b'), big('c')), { conflict: true });
});

/* The wiring: main decides before it writes, and the viewer's save goes through it. */
const main = fs.readFileSync('src/main/main.ts', 'utf8');
const app = fs.readFileSync('renderer/app.js', 'utf8');
const handlerOf = (src: string, ch: string) => src.slice(src.indexOf(`ipcMain.handle('${ch}'`), src.indexOf('\n});\n', src.indexOf(`ipcMain.handle('${ch}'`)));
const viewerSave = (src: string) => src.slice(src.indexOf('async function saveNow('), src.indexOf('\n  }\n', src.indexOf('async function saveNow(')));
const ask = (src: string) => src.slice(src.indexOf('async function askConflict('), src.indexOf('\n  }\n', src.indexOf('async function askConflict(')));

function guarded(name: string, src: string, check: (s: string) => boolean, breakIt: (s: string) => string): void {
  test(name, () => {
    assert.ok(check(src), `${name}: the check does not hold on the real source`);
    const broken = breakIt(src);
    assert.notEqual(broken, src, `${name}: the negative control changed nothing`);
    assert.equal(check(broken), false, `${name}: the check still passes on a broken copy — it proves nothing`);
  });
}

guarded('main reads the disk and decides BEFORE writing; a conflict writes nothing', main,
  (s) => { const h = handlerOf(s, 'fs:saveMerged'); const read = h.indexOf('readFileSync(abs'), dec = h.indexOf('decideSave(base, mine, disk'), conf = h.indexOf("if ('conflict' in d) return"), write = h.indexOf('writeFileSync(tmp'); return read > 0 && read < dec && dec < conf && conf < write; },
  (s) => s.replace("if ('conflict' in d) return { ok: false, conflict: true, disk, copy: keepOnConflict === true ? writeConflictCopy(abs, mine) : null };", ''));

guarded('the viewer saves through fs:saveMerged with its base, never with a plain write to the note', app,
  (s) => { const v = viewerSave(s); return /fsSaveMerged\(file\.path, base, content, prefer\)/.test(v) && !/fsWrite\(/.test(v) && !/fsWrite\(/.test(ask(s)); },
  (s) => s.replace('window.glassShell.fsSaveMerged(file.path, base, content, prefer)', 'window.glassShell.fsWrite(file.path, content)'));

guarded('a conflict copy is a NEW file: created exclusively, never over an existing one, and never deleted by the App (second pass #1)', main,
  (s) => { const h = s.slice(s.indexOf('function writeConflictCopy('), s.indexOf('\n}\n', s.indexOf('function writeConflictCopy('))); return /writeFileSync\(target, content, \{ flag: 'wx' \}\)/.test(h) && /code !== 'EEXIST'/.test(h) && !/unlinkSync|rmSync|removeSideCopy/.test(s.slice(s.indexOf("ipcMain.handle('fs:saveMerged'"), s.indexOf("ipcMain.handle('fs:writeConflictCopy'") + 2000)); },
  (s) => s.replace("fs.writeFileSync(target, content, { flag: 'wx' })", 'fs.writeFileSync(target, content)'));

guarded('"keep mine": main copies the disk\'s version beside the note in the same step, before writing, and a failed copy writes nothing (third pass #5)', main,
  (s) => { const h = handlerOf(s, 'fs:saveMerged'); const cp = h.indexOf('copy = writeConflictCopy(abs, disk);'), stop = h.indexOf('if (!copy) return { ok: false };'), write = h.indexOf('writeFileSync(tmp'); return cp > 0 && cp < stop && stop < write; },
  (s) => s.replace("    if (!copy) return { ok: false };   // no copy, no decision: nothing is overwritten\n", ''));

guarded('"use the disk": the operator\'s text is copied beside the note before the screen takes the disk\'s version', app,
  (s) => { const a = ask(s); const cp = a.indexOf('fsWriteConflictCopy(file.path, shownNow())'), gate = a.indexOf('if (!copy) {'), take = a.indexOf('base = file.content = disk'); return cp > 0 && cp < gate && gate < take; },
  (s) => s.replace("      if (!copy) { toast(t('viewer.saveFailed', { name })); return; }   // nothing decided; the tab stays unsaved and is saved on close\n", ''));

guarded('the conflict question never answers itself: another dialog taking over means "ask again later", and it waits for open dialogs (third pass #3)', app,
  (s) => { const c = s.slice(s.indexOf('function choiceModal('), s.indexOf('function choiceModal(') + 700); const a = ask(s); return /claimModal\(wrap, \(\) => done\(null\)\);/.test(c) && /while \(pick === null\)/.test(a) && /while \(document\.querySelector\('\.modal-wrap'\)\)/.test(a); },
  (s) => s.replace('const safe = choices[choices.length - 1].key;\n    claimModal(wrap, () => done(null));', 'const safe = choices[choices.length - 1].key;\n    claimModal(wrap, () => done(safe));'));

test('"keep mine" on a note too big to diff writes mine instead of asking forever (third pass #1)', () => {
  const big = (k: string) => Array.from({ length: 2500 }, (_, i) => `${k}${i}`).join('\n');
  assert.deepEqual(decideSave(big('a'), big('b'), big('c')), { conflict: true }, 'without a choice: ask');
  assert.deepEqual(decideSave(big('a'), big('b'), big('c'), 'mine'), { write: big('b') }, 'with "keep mine": mine (the disk is in the copy)');
});

guarded('every mode paints from the text on screen, so switching Rendered/Edit never drops an unsaved edit (review #1, #3)', app,
  (s) => /buildCodeEditor\(toEditor\(file\.content\)/.test(s) && /onInput: \(v\) => \{ file\.content = v;/.test(s),
  (s) => s.replace('onInput: (v) => { file.content = v;', 'onInput: (v) => {'));

const flushOf = (src: string) => src.slice(src.indexOf('paneObj.flushSave = (quitting) => {'), src.indexOf('\n  };\n', src.indexOf('paneObj.flushSave = (quitting) => {')));
guarded('closing the tab or quitting saves an unsaved note, timer or not, and a quit sends it outside the queue (third pass #2, #4)', app,
  (s) => { const f = flushOf(s); return /if \(!saveTimer && !paneObj\.dirty\) return;/.test(f) && /else void window\.glassShell\.fsSaveMerged\(file\.path, base, shownNow\(\)(, undefined, true)?\)/.test(f)
    && /if \(p\.flushSave\) p\.flushSave\(\);/.test(s.slice(s.indexOf('function closePane('), s.indexOf('function closePane(') + 400)) && /p\.flushSave\(true\)/.test(s); },
  (s) => s.replace('if (!saveTimer && !paneObj.dirty) return;', 'if (!saveTimer) return;'));

guarded('an open note that changed on disk reloads only when nothing is unsaved and no question is open', app,
  (s) => /paneObj\.onDiskMaybeChanged = async \(\) => \{\n\s*if \(paneObj\.dirty \|\| paneObj\.asking/.test(s) && /p\.onDiskMaybeChanged\(\)/.test(s),
  (s) => s.replace('if (paneObj.dirty || paneObj.asking || !editable) return;', 'if (!editable) return;'));

test('a checkbox ticked in Rendered mode is counted on the text on screen and saves through the same path', () => {
  const box = app.slice(app.indexOf('// live task checkboxes'), app.indexOf('wrap.appendChild(md);', app.indexOf('// live task checkboxes')));
  assert.match(box, /const updated = file\.content\.replace\(/);
  assert.match(box, /file\.content = updated; setDirty\(true\); paint\(\);\s*void save\(updated\);/);
  assert.doesNotMatch(box, /fsWrite\(/);
});

test('"Keep my changes": mine win on the clashing lines, the agent\'s other changes stay (review #4)', () => {
  const mine = note.replace('ship 0.15.2', 'ship 0.15.2 MINE');
  const disk = note.replace('ship 0.15.2', 'ship 0.15.2 THEIRS') + 'agent appended\n';
  assert.deepEqual(decideSave(note, mine, disk), { conflict: true }, 'without a choice, it asks');
  const d = decideSave(note, mine, disk, 'mine');
  assert.ok('write' in d && d.write.includes('ship 0.15.2 MINE') && !d.write.includes('THEIRS') && d.write.includes('agent appended'));
  assert.ok(!agentLineSurvives((b, m) => ({ write: m })), 'negative control: a plain overwrite drops the agent\'s lines');
});

test('both inserted at one point and one holds the other: the shared lines are written once (review #7, second pass #7)', () => {
  assert.deepEqual(merge3('x\n', 'x\nfoo\nbar\n', 'x\nfoo\n'), { ok: true, text: 'x\nfoo\nbar\n' }, 'typed below the agent\'s line');
  assert.deepEqual(merge3('a\nz\n', 'a\nmine\nfoo\nz\n', 'a\nfoo\nz\n'), { ok: true, text: 'a\nmine\nfoo\nz\n' }, 'typed ABOVE the agent\'s line');
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

guarded('quitting into a conflict keeps the operator\'s text beside the note: nobody is there to answer (fourth review)', main + '\n' + app,
  (s) => /if \('conflict' in d\) return \{ ok: false, conflict: true, disk, copy: keepOnConflict === true \? writeConflictCopy\(abs, mine\) : null \};/.test(s)
    && /fsSaveMerged\(file\.path, base, shownNow\(\), undefined, true\)/.test(s),
  (s) => s.replace('fsSaveMerged(file.path, base, shownNow(), undefined, true)', 'fsSaveMerged(file.path, base, shownNow())'));

