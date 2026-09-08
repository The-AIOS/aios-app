/**
 * Icon integrity.
 *
 * Two glyphs that draw the same thing are not a cosmetic problem: they make two different
 * actions indistinguishable, and the collapsed rail is nothing BUT glyphs. Both defects this
 * guards against shipped for real —
 *   · `rocket` and `design` are different paths that render as the same diagonal stroke, so the
 *     QUICK card and its spawn row read as "designer" (reported by the operator).
 *   · `bolt` was added as a byte-identical copy of `skill`, putting the same shape on a card
 *     header and one of its own rows (caught here, one minute after being introduced).
 * The first needs eyes. The second is pure mechanics, so it belongs in CI, not in a review.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

const app = fs.readFileSync('renderer/app.js', 'utf8');
const block = /const ICONS = \{[\s\S]*?\n\};/.exec(app);
assert.ok(block, 'the ICONS table must be findable — it is the source for every glyph');
const ICONS: Record<string, string> = new Function(block![0] + '\nreturn ICONS;')();

test('no two icons draw the same glyph', () => {
  const byPath = new Map<string, string>();
  const dupes: string[] = [];
  for (const [name, d] of Object.entries(ICONS)) {
    const key = d.replace(/\s+/g, ' ').trim();
    if (byPath.has(key)) dupes.push(`${byPath.get(key)} === ${name}`);
    else byPath.set(key, name);
  }
  assert.deepEqual(dupes, [], `identical glyphs make distinct actions indistinguishable: ${dupes.join(', ')}`);
});

test('every icon referenced by the UI actually exists', () => {
  /* A missing name silently falls back to ICONS.file, so the button renders a page glyph and
     nobody notices — the same silent-wrong-output shape as the rest of this week's bugs. */
  const used = new Set<string>();
  for (const m of app.matchAll(/(?:emoji|icon):\s*'([a-zA-Z]+)'/g)) used.add(m[1]);
  for (const m of app.matchAll(/\bicon\('([a-zA-Z]+)'/g)) used.add(m[1]);
  const missing = [...used].filter((n) => !(n in ICONS));
  assert.deepEqual(missing, [], `referenced but undefined, so they fall back to the file glyph: ${missing.join(', ')}`);
});

test('QUICK does not wear the glyph of any row inside it', () => {
  // The specific mistake: a card header sharing a shape with one of its own actions.
  const header = /pQuick: '([a-z]+)'/.exec(app);
  assert.ok(header, 'the QUICK card must declare an icon');
  const quickBlock = /── Quick: the doers ──[\s\S]*?── Workspaces ──/.exec(app);
  assert.ok(quickBlock, 'the QUICK card body must be findable');
  const rows = [...quickBlock![0].matchAll(/emoji: '([a-zA-Z]+)'/g)].map((m) => m[1]);
  assert.ok(rows.length >= 5, 'sanity: the QUICK card has rows');
  assert.ok(!rows.includes(header![1]),
    `the QUICK header (${header![1]}) must differ from its rows: ${rows.join(', ')}`);
});

test('the four title-bar reference glyphs are ONE family — same outline, different marks', () => {
  /* Operator-reported: the cluster "looks like multi-flavored… i love some kind of consistency".
     It was four unrelated metaphors for four documents — a book, a blank page, a ?-in-a-circle
     and a keyboard — and the ?-in-a-circle is the universal HELP glyph, so the CHEATSHEET wore
     the assistant's meaning while saying nothing about a cheatsheet.
     The fix is one page outline with four different interior marks. This guard exists because the
     outline is REPEATED in each entry rather than shared from a constant (ICONS is evaluated in
     isolation above, so it cannot reach one) — which means the only thing keeping the family
     together is this test. */
  const family = ['docManual', 'docReadme', 'docCheat', 'docKeys'];
  const OUTLINE = '<rect x="5" y="3" width="14" height="18" rx="2"/>';
  for (const n of family) {
    assert.ok(ICONS[n], `${n} must exist — it is one of the four references`);
    assert.ok(ICONS[n].startsWith(OUTLINE),
      `${n} must be drawn on the shared page outline, or the family stops being one`);
    assert.ok(ICONS[n].length > OUTLINE.length + 10,
      `${n} needs an interior mark — the bare outline would be indistinguishable from its siblings`);
  }
  /* And the marks must actually differ: four identical pages would pass the check above while
     making four buttons impossible to tell apart, which is this suite's founding defect. */
  const marks = family.map((n) => ICONS[n].slice(OUTLINE.length));
  assert.equal(new Set(marks).size, family.length, 'each reference needs its own interior mark');

  /* The retired glyphs must not come back on these buttons. `help` is the one that matters: it
     means help everywhere, and the assistant is what help means here. */
  assert.doesNotMatch(app, /dragCheat\.innerHTML = icon\('help'/, 'the cheatsheet is not the help glyph');
  assert.doesNotMatch(app, /dragKeys\.innerHTML = icon\('keyboard'/, 'shortcuts joined the page family');

  /* ONE SIZE across the cluster. The cup rendered at 17 while everything else was 15, which is
     half of what "multi-flavoured" was describing. */
  /* Read the cluster's ACTUAL children out of the markup rather than pattern-matching variable
     names — the first version of this assertion matched `drag*`/`rail*` anywhere on a line and
     swept up unrelated icon calls (22/13/16), reporting a failure that was purely its own. */
  const html = fs.readFileSync('renderer/index.html', 'utf8');
  const cluster = /<div id="dragacts">([\s\S]*?)<\/div>/.exec(html);
  assert.ok(cluster, 'the title-bar cluster must be findable');
  const btns = [...cluster![1].matchAll(/id="(\w+)"/g)].map((m) => m[1]);
  assert.ok(btns.length >= 8, `sanity: the cluster has buttons, saw ${btns.length}`);
  const sizes: Record<string, number> = {};
  for (const id of btns) {
    /* Only lines that name the button AND paint a glyph. Two buttons paint through a local
       variable instead of their id and are simply not found here — asserting on what IS found
       beats asserting on a list this test would have to keep in step by hand. */
    const m = new RegExp(`${id}[^\n]{0,40}innerHTML = icon\\((?:on \\? '\\w+' : )?'\\w+', (\\d+)\\)`).exec(app);
    if (m) sizes[id] = Number(m[1]);
  }
  const found = Object.values(sizes);
  assert.ok(found.length >= 5, `sanity: found sizes for ${found.length} cluster glyphs`);
  assert.deepEqual([...new Set(found)], [15],
    `every title-bar glyph renders at 15px, saw ${JSON.stringify(sizes)}`);
});
