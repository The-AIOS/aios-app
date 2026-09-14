/**
 * A card the stylesheet hides by default must be revealed with an EXPLICIT display value.
 *
 * THE BUG THIS EXISTS FOR, measured on a live install 2026-09-14. `#pInbox` — the "NEEDS YOU"
 * card, which carries sessions blocked on a permission, go-with-agents suggestions, the ritual
 * nudge and the framework-update row — carried `display: none` in the stylesheet so it could not
 * flash before its first render, and was revealed with `style.display = ''`.
 *
 * `style.display = ''` does not SET a value; it DELETES the inline declaration. The element then
 * falls back to the stylesheet, which says `none`. So hiding worked and showing was a silent
 * no-op: the card could never appear, on any version ever shipped. The operator's report was
 * "I have no idea where's the NEEDS YOU card" — it had never once been drawn.
 *
 * `#pNudge` sits twelve lines away in the same stylesheet, reveals itself with an explicit
 * 'block', and works. One character apart, and nothing could tell them apart at runtime: both
 * functions ran, both returned, and the difference was only ever visible on screen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';

const app = (): string => fs.readFileSync('renderer/app.js', 'utf8');
const css = (): string => fs.readFileSync('renderer/theme.css', 'utf8');

/** Element ids the stylesheet hides by default — the ones that need an explicit reveal. */
function cssHidden(): Set<string> {
  const out = new Set<string>();
  for (const m of css().matchAll(/#([A-Za-z][\w-]*)\s*\{([^}]*)\}/g)) {
    if (/display:\s*none/.test(m[2])) out.add(m[1]);
  }
  return out;
}

test('the stylesheet still hides these cards by default — the precondition for the rule', () => {
  /* If this fails the rule below may be moot rather than broken: check whether the card still
     needs hiding at all before deleting anything. */
  const hidden = cssHidden();
  assert.ok(hidden.has('pInbox'), '#pInbox is expected to be display:none by default');
  assert.ok(hidden.has('pNudge'), '#pNudge likewise');
  assert.ok(hidden.size >= 2, `expected several CSS-hidden ids, found ${[...hidden].join(', ')}`);
});

test("NO CSS-hidden element is revealed with style.display = '' — it is a silent no-op", () => {
  const src = app();
  const hidden = cssHidden();
  const offenders: string[] = [];
  for (const m of src.matchAll(/(\w+)\.style\.display\s*=\s*''/g)) {
    const varName = m[1];
    const line = src.slice(0, m.index).split('\n').length;
    // resolve the variable back to the element id it was fetched from
    const back = src.slice(Math.max(0, (m.index ?? 0) - 3000), m.index);
    const ids = [...back.matchAll(new RegExp(`${varName}\\s*=\\s*document\\.getElementById\\('([^']+)'\\)`, 'g'))];
    const id = ids.length ? ids[ids.length - 1][1] : '';
    if (id && hidden.has(id)) offenders.push(`app.js:${line} reveals #${id} with '' — the stylesheet re-hides it`);
  }
  assert.deepEqual(offenders, [], offenders.join('\n'));
});

test('pInbox is revealed with an explicit value, and still hidden explicitly when empty', () => {
  const src = app();
  const i = src.indexOf('function renderInboxCard');
  assert.ok(i > 0, 'renderInboxCard must exist');
  const body = src.slice(i, src.indexOf('\nfunction ', i + 10));
  assert.match(body, /I\.style\.display = 'none'/, 'an empty card hides — a permanent empty card teaches you to stop looking');
  assert.match(body, /I\.style\.display = 'block'/, "and a populated card shows with an EXPLICIT value, never ''");
  assert.doesNotMatch(body.replace(/\/\*[\s\S]*?\*\//g, ''), /style\.display = ''/, "no '' reveal may return here");
});

test('the working sibling proves the idiom — pNudge reveals explicitly too', () => {
  /* Kept as a control: if someone "simplifies" pNudge to '' the same way, this fails and names
     the pattern rather than leaving the next person to rediscover it on a screenshot. */
  const src = app();
  const i = src.indexOf("const inboxHasNudge");
  const body = src.slice(i, i + 1200);
  assert.match(body, /n\.style\.display = 'block'/, 'pNudge must reveal with an explicit value');
});
