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
