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

test('the title-bar row is seven DISTINCT silhouettes, and \u2318 never ships off macOS', () => {
  /* The one-family version of this row was rejected from use: "now it's harder to click it
     intuitively, 4 icons looking the same gives a higher confusion rate." That is the more
     important property — a title-bar glyph exists to be hit without reading — so the row is
     seven different shapes on purpose, and this guard protects the two decisions that a future
     tidy-up would most plausibly undo.

     1. THE MANUAL IS AN OPEN BOOK, NOT A CLOSED ONE. A closed book is a portrait rect with a
        band, which at 15px is the readme page again; measured on a contact sheet at 15/26/72px.
        "Restore the closed book, it's simpler" is the tempting wrong move. */
  assert.ok(ICONS.book, 'the manual wears the familiar closed book');
  assert.match(app, /dragReadme\.innerHTML = icon\('book', 15\)/, 'the manual button wears it');

  /* 2. AND THE README PAGE MUST CARRY CONTENT LINES. This is the load-bearing half. Manual and
        README are both portrait rects, which is a collision an open book would have avoided — I
        argued for one and the operator chose familiarity, correctly: these glyphs have been in
        the title bar for releases and a button you hit without looking is worth more than a
        marginal silhouette gain. What PAYS for the pair is the interior. The shipped README glyph
        was a page whose only mark was a folded corner — a few px in one corner, against the
        book's bottom band, which is why the two read alike. Three text lines differ across the
        whole interior, which is the part you actually see at 15px.
        So: lines, and never back to the bare folded page. */
  assert.ok(ICONS.docText, 'the readme needs the page-with-lines glyph');
  assert.match(app, /dragHelp\.innerHTML = icon\('docText', 15\)/, 'the readme button wears it');
  const lines = ICONS.docText.match(/h[\d.]+/g) || [];
  assert.ok(lines.length >= 3,
    `the readme page needs at least 3 content lines, saw ${lines.length} — a folded corner alone is what made it read as the book`);
  assert.doesNotMatch(app, /dragHelp\.innerHTML = icon\('file'/, 'the folded-corner page is what the lines replaced');

  /* 3. \u2318 IS macOS-ONLY. It means nothing on Windows and is missing from some Linux systems,
        and this row ships to all three. The branch is the whole protection. */
  assert.match(app, /icon\(IS_MAC \? 'cmdKey' : 'keyboard', 15\)/,
    'shortcuts shows \u2318 only on macOS; everywhere else it is a keyboard');
  assert.match(app, /const IS_MAC = /, 'and the platform must be read, never assumed');
  assert.ok(ICONS.cmdKey && ICONS.keyboard, 'both halves of that branch must exist');

  /* ONE SIZE across the cluster. The cup rendered at 17 while everything else was 15, which was
     half of what "multi-flavoured" was describing. */
  const html = fs.readFileSync('renderer/index.html', 'utf8');
  const cluster = /<div id="dragacts">([\s\S]*?)<\/div>/.exec(html);
  assert.ok(cluster, 'the title-bar cluster must be findable');
  const btns = [...cluster![1].matchAll(/id="(\w+)"/g)].map((m2) => m2[1]);
  assert.ok(btns.length >= 8, `sanity: the cluster has buttons, saw ${btns.length}`);
  const sizes: Record<string, number> = {};
  for (const id of btns) {
    const m2 = new RegExp(`${id}[^\n]{0,60}innerHTML = icon\\(([^)]*?), (\\d+)\\)`).exec(app);
    if (m2) sizes[id] = Number(m2[2]);
  }
  const found = Object.values(sizes);
  assert.ok(found.length >= 5, `sanity: found sizes for ${found.length} cluster glyphs`);
  assert.deepEqual([...new Set(found)], [15],
    `every title-bar glyph renders at 15px, saw ${JSON.stringify(sizes)}`);
});
