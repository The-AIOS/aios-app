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

/* Item 2 (2026-07-30) — `/rename` left the tab reading "(ended)" while the sessions list showed
   the new name. Not a display bug: liveness was keyed on the NAME, and a rename removes the old
   name from the registry's live list, so a healthy session was declared over. The third bug in
   this same seam (see AI-64), and the same lesson each time — a label is not an identity. */

test('a rename must be followed by identity, not mistaken for a death', () => {
  const pulse = /const liveNames = new Set\(m\.running[\s\S]*?renamePane\(pid, t\('tab\.endedSession'[\s\S]*?\n    \}/.exec(app);
  assert.ok(pulse, 'the ending-detection block must be findable');
  const block = pulse[0];
  assert.match(block, /byId\.get\(pane\.sessionId\)/,
    'liveness must be decided from the stable sessionId');
  assert.match(block, /entry\.name !== pane\.confirmedName/,
    'a live id under a NEW name is a rename, and the tab must adopt it');
  assert.match(block, /liveNames\.has\(pane\.confirmedName\)/,
    'panes confirmed before ids were captured must still fall back to the name check — otherwise they become immortal');
});

test('the confirm path captures the stable id, or the fix above has nothing to key on', () => {
  assert.match(app, /p\.sessionId = hit\.id \|\| null;/,
    'confirming a session must record its sessionId alongside the name');
});

/* Item 3b (2026-07-30) — "Good morning" at 4pm. The salute was computed once at paint time, with
   a duplicate copy of the same ternary at each call site. Both halves matter: one definition, and
   something that corrects it while the window stays open. */

test('the salute has exactly ONE definition', () => {
  const inline = [...app.matchAll(/getHours\(\)/g)];
  assert.equal(inline.length, 1,
    `only saluteBucket() may read the clock for the greeting; found ${inline.length} readers`);
  assert.match(app, /function saluteBucket\(d\)/, 'the shared definition must exist');
  // and no site may re-derive the buckets by hand
  assert.doesNotMatch(app, /home\.morning'\) : .*home\.afternoon/,
    'an inline morning/afternoon ternary is the duplicate that drifted');
});

test('the greeting is corrected while the window stays open', () => {
  assert.match(app, /setInterval\(refreshSalutes, 60 \* 1000\)/,
    'a tick must correct it — without one the fix only works on repaint');
  assert.match(app, /window\.addEventListener\('focus', refreshSalutes\)/,
    'and on focus, since a slept laptop may have had its timers throttled');
  // it must update in place, not re-render: a greeting that repaints the panel would
  // disturb whatever the operator is doing, once a minute, forever.
  assert.match(app, /if \(node\.dataset\.salute === key\) continue;/,
    'unchanged buckets must be left completely alone');
});

/* Item 4 (2026-07-30) — "the explorer sometimes doesn't show new folders or files". There WAS a
   recursive watcher; the loss was downstream. relistFolder() returned early when the container's
   offsetParent was null, which is true both for a collapsed folder AND for a hidden explorer —
   so an event that arrived while the tree was closed was DISCARDED, and nothing re-listed when it
   reopened. "Sometimes" was "whenever the explorer happened to be hidden". Same shape as the
   terminal bug the night before: work thrown away while hidden, with no recovery on show. */

test('a refresh for a hidden folder is DEFERRED, never dropped', () => {
  const fn = /async function relistFolder\(dir\) \{[\s\S]*?\n\}/.exec(app);
  assert.ok(fn, 'relistFolder must be findable');
  assert.match(fn[0], /staleDirs\.add\(dir\); return;/,
    'an invisible container must remember it needs re-listing');
  assert.doesNotMatch(fn[0], /offsetParent === null\) return;(?! )/,
    'a bare early return here is the discard that caused the bug');
});

test('and something actually flushes it when the tree becomes visible', () => {
  assert.match(app, /async function flushStaleDirs\(\)/, 'the flush must exist');
  assert.match(app, /void flushStaleDirs\(\); \}, 0\);/,
    'applyLayout is the funnel every visibility change passes through — flush there');
  // it must only touch dirs that are now visible, or it silently drops them a second time
  const flush = /async function flushStaleDirs\(\) \{[\s\S]*?\n\}/.exec(app);
  assert.ok(flush, 'flushStaleDirs must be findable');
  assert.match(flush![0], /if \(!c \|\| c\.offsetParent === null\) continue;/,
    'still-hidden dirs must stay pending, not be cleared');
});

test('the refresh button supersedes pending relists rather than racing them', () => {
  assert.match(app, /staleDirs\.clear\(\);\s+\/\/ a full rebuild supersedes/,
    'a full rebuild makes every pending relist moot — leaving them queued would re-list twice');
});

/* Item 6 (2026-07-30) — editor zoom. Two properties are worth guarding: the overlay pair must
   never be able to drift apart, and the shortcut must not depend on `e.key` for '+'. */

test('the highlight/textarea overlay pair share ONE font declaration', () => {
  const css = fs.readFileSync('renderer/theme.css', 'utf8');
  const rule = /\.codehl, \.codeta \{[\s\S]*?\}/.exec(css);
  assert.ok(rule, 'the pair must stay in a single rule');
  assert.match(rule[0], /font-size: calc\(12\.5px \* var\(--edzoom\)\)/,
    'both must scale by the same multiplier in the same declaration');
  // a separate .codeta font-size would let the caret drift from the glyphs it sits in
  const solo = /\n\.codeta \{[^}]*font-size/.exec(css);
  assert.equal(solo, null, 'a .codeta-only font-size would desynchronise the caret from the text');
});

test('zoom has exactly ONE owner — the menu', () => {
  /* This test used to assert a renderer keydown handler keyed on `e.code`. That handler existed
     ALONGSIDE the menu accelerators, so both fired and every press stepped the zoom twice —
     invisible as a bug because it merely felt fast. Electron resolves menu accelerators itself
     and handles keyboard layouts, so the renderer copy was redundant as well as harmful. */
  const menuSrc = fs.readFileSync('src/main/menu.ts', 'utf8');
  assert.match(menuSrc, /accelerator: 'CmdOrCtrl\+Plus', click: \(\) => intent\('zoom', \{ delta: 0\.1 \}\)/);
  assert.match(menuSrc, /accelerator: 'CmdOrCtrl\+-', click: \(\) => intent\('zoom', \{ delta: -0\.1 \}\)/);
  assert.match(menuSrc, /accelerator: 'CmdOrCtrl\+Shift\+0', click: \(\) => intent\('zoom', \{ reset: true \}\)/);
  assert.doesNotMatch(app, /code === 'Equal' \|\| code === 'NumpadAdd'/,
    'a second renderer handler double-steps every press');
  assert.match(app, /case 'zoom':/, 'and the renderer must handle the intent');
});

test('zoom is clamped and persisted', () => {
  assert.match(app, /ED_ZOOM_MIN = 0\.7, ED_ZOOM_MAX = 2\.0/, 'bounds must exist');
  assert.match(app, /pOn, termRenderer, edZoom \}\)/, 'the level must survive a restart');
  // and a restored value outside the bounds must not be trusted
  assert.match(app, /v >= ED_ZOOM_MIN && v <= ED_ZOOM_MAX \? v : 1/,
    'a corrupt or out-of-range saved zoom must fall back, not apply');
});

/* Item 5 (2026-07-30) — find in the open file. The risky choice here is HOW matches are marked:
   wrapping them in <mark> would mutate live content — splitting links in rendered markdown,
   shifting the git gutter's line arithmetic, and breaking the editor overlay's glyph alignment
   with its textarea. The CSS Custom Highlight API paints without touching the DOM. */

test('find highlights without mutating the document', () => {
  assert.match(app, /CSS\.highlights\.set\('aios-find'/, 'must use the Custom Highlight API');
  const fn = /function runFind\(q\) \{[\s\S]*?\n\}/.exec(app);
  assert.ok(fn, 'runFind must be findable');
  assert.doesNotMatch(fn[0], /createElement\('mark'\)|innerHTML|surroundContents/,
    'no DOM mutation in the search path — that is the whole reason for the highlight API');
  const css = fs.readFileSync('renderer/theme.css', 'utf8');
  assert.match(css, /::highlight\(aios-find\)/, 'the highlight pseudo-element must be styled');
  assert.match(css, /::highlight\(aios-find-cur\)/, 'and the current match distinguished from the rest');
});

test('⌘F leaves the terminal alone', () => {
  // A terminal pane has no document surface; stealing ⌘F there would swallow a keystroke the
  // session may want and give the operator a search box over nothing.
  const handler = /if \(!\(e\.metaKey \|\| e\.ctrlKey\) \|\| e\.altKey \|\| e\.key\.toLowerCase\(\) !== 'f'\) return;[\s\S]*?\}, true\);/.exec(app);
  assert.ok(handler, 'the ⌘F handler must be findable');
  assert.match(handler[0], /if \(!findHost\(\)\) return;/,
    'no document surface means no interception');
});

test('the bar floats — it must not reflow the document it is searching', () => {
  const css = fs.readFileSync('renderer/theme.css', 'utf8');
  assert.match(css, /\.findbar \{ position: absolute;/,
    'an in-flow bar would shift every match the instant it appeared');
  assert.match(app, /getElementById\('panes'\)\.appendChild\(bar\)/,
    'mounted in .panezone, which is already positioned — making #work a containing block would '
    + 'silently change the coordinate system of every absolutely-positioned pane');
});

test('edit mode gets a real selection, not just a highlight', () => {
  const step = /function stepFind\(delta\) \{[\s\S]*?\n\}/.exec(app);
  assert.ok(step, 'stepFind must be findable');
  assert.match(step[0], /setSelectionRange\(before, before \+ FIND\.q\.length\)/,
    'the caret must land on the match so typing continues from there');
  assert.match(step[0], /dispatchEvent\(new Event\('scroll'\)\)/,
    'and the highlighted layer must be told to follow the textarea it mirrors');
});

/* Wrapping in edit mode (2026-07-30). Two things could silently break, and both are subtle
   enough to ship unnoticed: the two overlay layers wrapping DIFFERENTLY, and every position
   that was calculated as `(line - 1) * lineHeight`, which is only true while text does not wrap. */

test('both overlay layers wrap under one declaration, and nothing overrides it', () => {
  const css = fs.readFileSync('renderer/theme.css', 'utf8');
  const pair = /\.codehl, \.codeta \{[\s\S]*?\}/.exec(css);
  assert.ok(pair, 'the pair rule must exist');
  assert.match(pair[0], /white-space: pre-wrap/, 'both layers must wrap');
  assert.match(pair[0], /overflow-x: hidden/, 'wrapping means there is no horizontal axis left to scroll');
  // the inner <code> must NOT re-declare a conflicting wrap: highlight.js puts the text there,
  // so a `pre` on it wraps the textarea against a non-wrapping highlight layer.
  const inner = /\.codehl code \{[^}]*\}/.exec(css);
  assert.ok(inner, '.codehl code must exist');
  assert.doesNotMatch(inner[0], /white-space:\s*pre\s*;/,
    'a hard `pre` here desynchronises the caret from the glyphs');
  assert.match(inner[0], /white-space: inherit/, 'it must follow the layer above');
});

test('editor positions are MEASURED, not derived from lineHeight', () => {
  assert.match(app, /function lineTopIn\(pre, n\)/, 'the measurement helper must exist');
  // the gutter, go-to-line, and find all positioned things by multiplying a line number by the
  // line height — correct only while nothing wraps, and now nothing guarantees that.
  assert.match(app, /const top = lineTopIn\(pre, from\);/, 'the git gutter must measure');
  assert.match(app, /const lt = lineTopIn\(pre, line\);/, 'go-to-line must measure');
  assert.match(app, /const mrect = r\.getClientRects\(\)\[0\]/, 'find must reveal by the match rect');
  // and a failed measurement must degrade to the old arithmetic rather than vanish: a missing
  // dirty marker reads as "no change here", the one wrong answer the gutter must never give.
  assert.match(app, /top != null \? top : padTop \+ \(from - 1\) \* lh/,
    'an unmeasurable line must fall back, not disappear');
});

/* Undo vs the git gutter (2026-07-30). Typing was noticed; ⌘Z was not, so the gutter kept
   marking a change the operator had just reverted. Cause: `{ role: 'editMenu' }` means Undo
   travels through a menu accelerator, which can consume the keystroke before the renderer sees
   any event — so no `input`, no `keydown`, nothing to hook. */

test('the editor detects a change by asking the document, not by trusting an event', () => {
  const fn = /function buildCodeEditor\(initial, lang, hooks, gitPath\) \{[\s\S]*?\n\}\n/.exec(app);
  assert.ok(fn, 'buildCodeEditor must be findable');
  assert.match(fn[0], /if \(ta\.value === lastSeen\) return;/,
    'a value comparison is the only check that cannot be wrong about whether the text changed');
  assert.match(fn[0], /ta\.addEventListener\('input', onEdited\)/,
    'and `input` must stay wired, or ordinary typing waits on the poll interval');
  assert.match(fn[0], /if \(!ta\.isConnected\) \{ clearInterval\(watch\); return; \}/,
    'the watcher must stop itself — panes are discarded without an explicit dispose');
});

/* Item 7 (2026-07-30) — the resume picker lists NAMED sessions only. Of 592 transcripts on the
   reporting machine, 383 never wrote an `agent-name` row and could only be labelled
   `project · a3f9c2b1` — 65% of the list, identifying nothing. Resuming is an act of
   recognition, so the list holds what can be recognised. The rule that keeps this honest is
   that their absence is STATED, not discovered. */

test('unnamed sessions are excluded, and the count of them is surfaced', () => {
  const main = fs.readFileSync('src/main/main.ts', 'utf8');
  assert.match(main, /const items = all\.filter\(\(i\) => i\.name\);/,
    'the list must hold only sessions that can be identified');
  assert.match(main, /unnamed: all\.length - items\.length/,
    'and it must report how many were hidden — a silent omission is the thing to avoid');
  assert.match(app, /t\('resume\.sub3', \{ named: data\.named, unnamed: data\.unnamed \}\)/,
    'the picker must show that count to the operator');
  const en = JSON.parse(fs.readFileSync('src/i18n/locales/en.json', 'utf8'));
  assert.match(en['resume.sub3'], /\{unnamed\}/, 'the hidden count must appear in the visible string');
  assert.match(en['resume.sub3'], /picker/, 'and it must name the route that still reaches them');
});

test('an escape hatch to the full set remains', () => {
  // Excluding two thirds of the archive is only acceptable because another path reaches it.
  assert.match(app, /altAction: \{ label: t\('resume\.useClaudePicker'\)/,
    "Claude's own picker must stay reachable — it lists everything, named or not");
  assert.match(app, /if \(chosen\.alt\)/, 'and that route must be handled');
  // It must sit ABOVE the filter, not inside the list: an escape hatch placed among the choices
  // reads as one more choice.
  assert.match(app, /insertBefore\(alt, wrap\.querySelector\('#checkInput'\)\)/,
    'the alternative route belongs before the filter input');
});

test('resumable names are cached by path AND mtime', () => {
  const main = fs.readFileSync('src/main/main.ts', 'utf8');
  assert.match(main, /const key = file \+ ':' \+ mtime;/,
    'keying on path alone would serve a stale name after a transcript grows');
});

/* Scroll-to-load in the pickers (2026-07-30). Both modals rendered a fixed first 60 rows, so with
   209 named sessions the remaining 149 were reachable only by typing — the list simply stopped,
   and a list that stops silently looks complete. This is a render window, not paging: the data is
   already in memory, so there is no request and no loading state. */

test('both pickers grow their render window instead of capping at 60', () => {
  assert.doesNotMatch(app, /filtered\.slice\(0, 60\)/,
    'a hardcoded 60 is the wall this replaced');
  const windows = [...app.matchAll(/filtered\.slice\(0, shown\)/g)];
  assert.equal(windows.length, 2, 'checkModal AND listModal — the wall was app-wide, not session-specific');
});

test('growing preserves scroll position, or it loops', () => {
  // paint() calls replaceChildren(), which resets scrollTop. Growing without restoring it snaps
  // the view to the top and immediately re-triggers the growth that just happened.
  const grows = [...app.matchAll(/const keep = list\.scrollTop;[\s\S]{0,140}?list\.scrollTop = keep;/g)];
  assert.equal(grows.length, 2, 'both modals must restore the position they grew from');
});

test('the keyboard cannot hit an invisible wall either', () => {
  const arrows = [...app.matchAll(/if \(sel \+ 1 >= shown\) grow\(\);/g)];
  assert.equal(arrows.length, 2, 'arrowing past the window must grow it, in both pickers');
});

test('the remainder is stated, and a new filter starts a new window', () => {
  assert.match(app, /t\('modal\.moreBelow', \{ n: rest \}\)/, 'the count below must be visible');
  const resets = [...app.matchAll(/shown = ROWS_PAGE;/g)];
  assert.ok(resets.length >= 2, 'filtering must reset the window, or a narrow result inherits a huge one');
});

/* The shortcut map's accelerator formatter (2026-07-30). Two bugs shipped into the first render
   and were caught by eye within minutes, both from the same cause: chaining string replaces over
   a value whose separators and whose CONTENT use the same character. */

test('accelerator formatting: the plus KEY survives, and the slash is not prose', () => {
  const G = /const ACCEL_GLYPH = \{[\s\S]*?\};/.exec(app);
  const F = /function prettyAccel\(a\) \{[\s\S]*?\n\}/.exec(app);
  assert.ok(G && F, 'the formatter must be findable');
  const make = (platform: string) =>
    new Function('navigator', G![0] + '\n' + F![0] + '\nreturn prettyAccel;')({ platform }) as (a: string) => string;
  const mac = make('MacIntel');
  const win = make('Win32');

  // `CmdOrCtrl+Plus` rendered as `⌘` — Plus became a literal '+', then a later step stripped any
  // '+' following a modifier glyph, unable to tell a plus KEY from a plus SEPARATOR.
  assert.equal(mac('CmdOrCtrl+Plus'), '⌘+', 'the plus key must not be eaten as a separator');
  // `CmdOrCtrl+/` rendered as `⌘+/` — the free-form test treated the slash as "prose", but here
  // the slash IS the key.
  assert.equal(mac('CmdOrCtrl+/'), '⌘/', 'a slash key is part of the chord, not a list separator');

  assert.equal(mac('CmdOrCtrl+Shift+0'), '⌘⇧0');
  assert.equal(mac('CmdOrCtrl+Alt+Shift+R'), '⌘⌥⇧R');
  assert.equal(mac('CmdOrCtrl+-'), '⌘-');
  // genuine prose keeps its shape, but a glyph absorbs the separator that followed its word
  assert.equal(mac('Enter / Shift+Enter'), 'Enter / ⇧Enter');
  // and non-mac stays spelled out rather than showing mac glyphs
  assert.equal(win('CmdOrCtrl+Shift+0'), 'Ctrl+Shift+0');
});

test('every accelerator the menu declares renders without leaking a raw token', () => {
  /* The sweep that found both bugs, kept as a test: a formatter is only as good as its worst
     input, and the inputs are enumerable. */
  const G = /const ACCEL_GLYPH = \{[\s\S]*?\};/.exec(app)![0];
  const F = /function prettyAccel\(a\) \{[\s\S]*?\n\}/.exec(app)![0];
  const mac = new Function('navigator', G + '\n' + F + '\nreturn prettyAccel;')({ platform: 'MacIntel' }) as (a: string) => string;
  const menu = fs.readFileSync('src/main/menu.ts', 'utf8');
  const accels = [...new Set([...menu.matchAll(/accelerator: '([^']+)'/g)].map((m) => m[1]))];
  assert.ok(accels.length > 20, 'sanity: the menu declares accelerators');
  for (const a of accels) {
    const out = mac(a);
    assert.doesNotMatch(out, /CmdOrCtrl|\bPlus\b|\bShift\b|\bAlt\b/, `${a} leaked a raw token as "${out}"`);
    assert.ok(out.length <= 6, `${a} rendered suspiciously long as "${out}"`);
  }
});
