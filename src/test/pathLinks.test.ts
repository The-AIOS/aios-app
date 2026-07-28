/**
 * ⌘-click paths in the terminal (Dolores' request) — the CANDIDATE GENERATION, run for real.
 *
 * Three features stack here and each was correct in isolation while the stack was not:
 *   1. space-extension  — a path may contain spaces, so extend the match across tokens
 *   2. soft-wrap rejoin — xterm splits a long line across rows; rebuild the logical line
 *   3. hard-break join  — the PRINTER may break a path itself; join with the next line
 *
 * The field defect was (1)+(3): the join used the bare regex match, which stops at the first
 * space, so `…/vault/03 - ` ⏎ `export/…` lost its ` - ` and produced two strings that cannot
 * exist. Every other two-line path linked fine, because those had no extension to lose — the
 * failure was invisible until a path had BOTH properties.
 *
 * So these run the real `pathCandidates` and `joinAcrossBreak` out of renderer/app.js rather
 * than asserting on its source: a source match would have passed happily against the bug.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

const app = fs.readFileSync('renderer/app.js', 'utf8');

/** Lift the real implementations out of the renderer. No re-implementation: a paraphrased
 *  copy would drift from the shipped code and start guarding a fiction. */
function load(): { pathCandidates: Function; joinAcrossBreak: Function } {
  const grab = (re: RegExp, what: string) => {
    const m = re.exec(app);
    assert.ok(m, `could not find ${what} in renderer/app.js — did it get renamed?`);
    return m![0];
  };
  const src = [
    grab(/^const PATH_QUOTED_RE = .*$/m, 'PATH_QUOTED_RE'),
    grab(/^const PATH_RE = .*$/m, 'PATH_RE'),
    grab(/^function pathCandidates\(text\) \{[\s\S]*?\n\}/m, 'pathCandidates'),
    grab(/^function joinAcrossBreak\(hits, next, nextRow\) \{[\s\S]*?\n\}/m, 'joinAcrossBreak'),
    'return { pathCandidates, joinAcrossBreak };',
  ].join('\n');
  return new Function(src)() as { pathCandidates: Function; joinAcrossBreak: Function };
}

const { pathCandidates, joinAcrossBreak } = load();

/** Every string the provider will ask the filesystem about, for a line + its successor. */
function offered(line: string, next: string): string[] {
  const hits = pathCandidates(line);
  joinAcrossBreak(hits, next, 9);
  return hits.flatMap((h: any) => [h.value, ...h.alts]);
}

/* ── THE FIELD CASE ─────────────────────────────────────────────────────────── */

// Reported 2026-07-27: the one path that refused to link. Spaces AND a hard break.
const WHOLE = '/Users/chuycepeda/obsidian/vault/03 - export/chuycepeda/gifts/espacios-io-reposicionamiento';
const HEAD  = '- HTML with spaces — /Users/chuycepeda/obsidian/vault/03 - ';
const TAIL  = 'export/chuycepeda/gifts/espacios-io-reposicionamiento';

test('FIELD CASE: a path with spaces broken by a hard newline is offered whole', () => {
  assert.ok(offered(HEAD, TAIL).includes(WHOLE),
    'the reassembled path must be among the candidates — this is the exact string that failed');
});

test('NEGATIVE CONTROL: joining only the bare match would NOT produce it', () => {
  /* Proves the test can see the bug it was written for. This is the old logic, verbatim:
     if this ever starts finding the path, the assertion above has stopped meaning anything. */
  const hits = pathCandidates(HEAD);
  const tail: any = hits[hits.length - 1];
  const oldBehaviour = [tail.value + ' ' + TAIL, tail.value + TAIL];
  assert.ok(!oldBehaviour.includes(WHOLE),
    'the pre-fix join must MISS this path — otherwise there was never a bug to fix');
  assert.equal(tail.value, '/Users/chuycepeda/obsidian/vault/03',
    'and the reason is that the bare match stops at the first space');
});

/* ── THE CASES THAT ALREADY WORKED must keep working ────────────────────────── */

test('a break with no spaces still joins, with and without a space', () => {
  const got = offered('see /Users/chuycepeda/obsidian/vault/00 - notes/', 'projects/infra-aios-app.md');
  assert.ok(got.some((c) => c.endsWith('notes/projects/infra-aios-app.md')),
    'the no-space join must survive — this is the case that already worked in the field');
});

test('a path with spaces and NO break is unaffected', () => {
  const got = offered('open /Users/chuycepeda/obsidian/vault/03 - export/deck.html now', '');
  assert.ok(got.includes('/Users/chuycepeda/obsidian/vault/03 - export/deck.html'),
    'space-extension alone must not regress');
});

test('only line-ENDING candidates join — an earlier path must not swallow the next line', () => {
  // The gap is wider than the extension budget, so /tmp/first.md cannot reach the line end.
  const hits = pathCandidates('/tmp/first.md a b c d e f g /tmp/second.md');
  joinAcrossBreak(hits, 'trailing-prose.md', 9);
  const first: any = hits[0], last: any = hits[hits.length - 1];
  assert.ok(!first.alts.some((a: string) => a.includes('trailing-prose')),
    'a break can only occur at the END of a line, so a path that stops short is not eligible');
  assert.ok(last.alts.some((a: string) => a.includes('trailing-prose')),
    'while the one that does reach the end is');
});

test('when two candidates both reach the line end, BOTH join', () => {
  /* The tie is the common case, not an edge one: space-extension stretches an earlier path to
     the same end. Choosing one would need a tie-break, and the wrong choice means the real
     path never joins — the exact class of silent miss this ticket started as. */
  const hits = pathCandidates('see /tmp/a.md and /Users/chuycepeda/obsidian/vault/03 -');
  const joined = joinAcrossBreak(hits, 'export/deck.html', 9) as any[];
  assert.ok(joined.length >= 2, 'both line-ending candidates must be offered');
  assert.ok(joined.some((h) => h.joined.has('/Users/chuycepeda/obsidian/vault/03 - export/deck.html')),
    'including the absolute one, which a tie-break could have skipped');
});

/* ── THE RANGE, which decides what gets underlined ──────────────────────────── */

test('spansTo applies to ACTUALLY-joined strings, not merely longer ones', () => {
  /* The predicate was `best.text.length > m.length`, which is also true of a plain
     space-extension. On any line that HAS a successor, an extended-but-unjoined path would
     underline into the next row — a link whose highlight points somewhere it does not go. */
  const hits = pathCandidates('/Users/chuycepeda/obsidian/vault/03 - export/deck.html');
  joinAcrossBreak(hits, 'next-line.md', 9);
  const tail: any = hits[0];   // the absolute form, whose extension reaches the line end
  const extendedOnly = '/Users/chuycepeda/obsidian/vault/03 - export/deck.html';
  assert.ok(tail.alts.includes(extendedOnly), 'the extension is still offered');
  assert.ok(!tail.joined.has(extendedOnly),
    'but it did NOT cross a line, so it must not claim the next row');
  assert.ok(tail.joined.has(extendedOnly + 'next-line.md'), 'while a real join does');
});

test('INVARIANT: the provider delegates the join instead of re-inlining it', () => {
  assert.match(app, /joinAcrossBreak\(hits, L\.next, L\.nextRow\)/,
    'the link provider must call the shared join');
  assert.match(app, /m\.spansTo && m\.joined && m\.joined\.has\(best\.text\)/,
    'the range must be keyed on having actually joined, never on a length heuristic');
});

test('a break AFTER a space-containing segment joins the ABSOLUTE form, not the relative echo', () => {
  /* `…/03 - export/chuycepeda/gifts/` ⏎ `espacios-io-…` — space-extension emits a second,
     relative candidate (`export/chuycepeda/gifts/`) that is the ARRAY tail but starts mid-path.
     Joining that one offers a string resolvable only by accident against the cwd. */
  const got = offered('open /Users/chuycepeda/obsidian/vault/03 - export/chuycepeda/gifts/',
                      'espacios-io-reposicionamiento');
  assert.ok(got.includes(WHOLE), 'the absolute path must be offered whole');
});

test('a break immediately after a dot still resolves — the punctuation trim must not eat it', () => {
  /* `…-notas.` ⏎ `html`. Trailing-punctuation stripping is right for prose (`see /tmp/a.md.`)
     and wrong here: it shortened the absolute candidate below the line end, which handed
     eligibility to the relative echo of itself, whose join resolves only by accident. */
  const got = offered('- see /Users/chuycepeda/obsidian/vault/03 - export/notes.', 'html');
  assert.ok(got.includes('/Users/chuycepeda/obsidian/vault/03 - export/notes.html'),
    'the dot must survive into the join');
});

/* ── THE SWEEP ──────────────────────────────────────────────────────────────────
   Single cases prove single bugs. A path can break at ANY column, so sweep every one of them
   against a real file on disk — the same question the provider asks. Built in a temp dir with
   a space in its name so the fixture travels; asserting against the operator's own vault would
   make this pass on one machine and fail everywhere else. */

test('SWEEP: a spaced path breaking at any realistic column still resolves', (t) => {
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-paths-'));
  const dir = path.join(root, '03 - export', 'gifts');
  fs.mkdirSync(dir, { recursive: true });
  const real = path.join(dir, 'espacios-io-reposicionamiento-notas.html');
  fs.writeFileSync(real, 'x');
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* gone */ } });

  const misses: number[] = [];
  for (let i = 1; i < real.length; i++) {
    const head = '- HTML with spaces — ' + real.slice(0, i);
    const next = real.slice(i).replace(/^\s+/, '');
    if (!next) continue;
    // the provider links whatever RESOLVES, so ask the filesystem exactly as it does
    if (!offered(head, next).some((c) => { try { return fs.existsSync(c); } catch { return false; } })) misses.push(i);
  }
  /* The only tolerated misses are breaks inside the leading `/var/folders/…` segment, which
     need a terminal ~25 columns wide — narrower than the App can be resized to. Anything
     further right is a real path the operator could see, and must link. */
  const realistic = misses.filter((i) => i > 24);
  assert.deepEqual(realistic, [],
    `every break past column 24 must resolve; these did not: ${realistic.join(', ')}`);
});

/* AI-69 — a terminal must never be hidden with `display:none`. xterm's WebGL renderer bails on
   a zero-size container (`_refreshCharAtlas` → `_isAttached = false`), so a session still
   printing in the background paints into a detached renderer and the canvas you switch back to
   holds garbage. Guarded at source level because the failure is visual and non-deterministic —
   there is no assertion a headless run can make about it, but there IS one about the mechanism. */

test('AI-69: terminals hide by VISIBILITY, and every check consults both mechanisms', () => {
  assert.match(app, /const PANE_HIDDEN = 'panehidden'/, 'the hidden class must be declared');

  // setVisible must route through the helper, never assign display to a pane directly again
  const setVis = /function setVisible\(z\) \{[\s\S]*?\n\}/.exec(app);
  assert.ok(setVis, 'setVisible must exist');
  assert.doesNotMatch(setVis[0], /style\.display\s*=/,
    'setVisible must delegate to setPaneShown — a raw display assignment reintroduces the bug');
  assert.match(setVis[0], /setPaneShown\(p, on\)/, 'and it must use the helper');

  /* No OTHER site may test visibility by display: a hidden terminal is still `display:flex`,
     so such a check silently reads it as on-screen. The one legitimate raw read is inside
     paneShown() itself, which is the abstraction — exempt it by name, not by counting. */
  const shown = /function paneShown\(p\) \{[\s\S]*?\n\}/.exec(app);
  assert.ok(shown, 'paneShown must exist — it is the only sanctioned reader');
  const elsewhere = app.replace(shown[0], '');
  const strays = [...elsewhere.matchAll(/\.el\.style\.display\s*(===|!==)\s*'none'/g)];
  assert.deepEqual(strays.map((m) => m[0]), [],
    'a raw display check reads a hidden TERMINAL as visible — go through paneShown()');
});

test('AI-69: the CSS actually hides it, and blocks its pointer events', () => {
  const css = fs.readFileSync('renderer/theme.css', 'utf8');
  assert.match(css, /\.pane\.panehidden\s*\{[^}]*visibility:\s*hidden/,
    'the class must hide by visibility, not display');
  assert.match(css, /\.pane\.panehidden\s*\{[^}]*pointer-events:\s*none/,
    'a stacked, invisible pane must not eat the visible pane\'s clicks');
});
