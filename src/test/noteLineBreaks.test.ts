/**
 * The file viewer renders a note the way Obsidian does: one newline, one line break.
 *
 * The viewer parsed notes with marked's defaults, where a single newline is a SOFT break, read as
 * a space. So every note whose lines are meant to stand alone (a goals file, a todo.txt-style
 * list, an address, a poem) collapsed into one paragraph in the App while it read line by line
 * in Obsidian, whose "Strict line breaks" setting is off by default. The chat already renders
 * with `breaks: true`; the viewer did not.
 *
 * The options are lifted out of renderer/app.js and run through the real marked, rather than
 * matched as text: the defect was a missing option, and only rendering shows whether it is there.
 * The parse itself stays inline inside vaultSanitize (see vaultSanitize.test.ts), so the viewer
 * call is checked as source, with a negative control in the style of that suite.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

/* `require`, not `import`: marked ships ESM only, and this suite compiles to CommonJS. */
const { marked } = require('marked') as { marked: { parse(src: string, opts?: object): string } };

const app = fs.readFileSync('renderer/app.js', 'utf8');

/** The real options object the viewer passes to marked, evaluated from the shipped source. */
function noteOptions(): object {
  const m = /^const NOTE_MD = (\{[^\n]*\});$/m.exec(app);
  assert.ok(m, 'could not find NOTE_MD in renderer/app.js — did it get renamed?');
  return new Function(`return ${m![1]};`)() as object;
}
const render = (md: string): string => marked.parse(md, noteOptions());
const count = (html: string, re: RegExp): number => (html.match(re) || []).length;

test('a single newline in a note renders as a line break, not a space', () => {
  const html = render('first line\nsecond line\nthird line');
  assert.equal(count(html, /<br>/g), 2, `each newline should be a <br>, got: ${html}`);
  assert.equal(count(html, /<p>/g), 1, 'still one paragraph — only the breaks change');
});

test('a blank line still starts a new paragraph, and lists and tables still render', () => {
  assert.equal(count(render('one\n\ntwo'), /<p>/g), 2);
  assert.match(render('- a\n- b'), /<ul>[\s\S]*<li>a<\/li>[\s\S]*<li>b<\/li>/);
  assert.match(render('| a | b |\n|---|---|\n| 1 | 2 |'), /<table>/, 'GitHub tables need gfm on');
});

const viewerUsesNoteOptions = (src: string): boolean =>
  /md\.replaceChildren\(vaultSanitize\(marked\.parse\(src, NOTE_MD\)\)\);/.test(src);

test('the file viewer parses notes with NOTE_MD, still inside vaultSanitize', () => {
  assert.ok(viewerUsesNoteOptions(app), 'the markdown viewer must parse with NOTE_MD');
  const broken = app.replace('marked.parse(src, NOTE_MD)', 'marked.parse(src)');
  assert.notEqual(broken, app, 'the negative control did not change anything');
  assert.equal(viewerUsesNoteOptions(broken), false, 'the check still passes on marked\'s defaults');
});
