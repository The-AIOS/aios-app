/**
 * Split view arithmetic (AI-82).
 *
 * The spec's own warning is that "the interaction sweep is where this breaks, not the tiling" —
 * so these tests cover the tiling completely and cheaply, in order to leave the walk-through free
 * to spend its attention on focus, zen, preset switches and restart.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import {
  MAX_VISIBLE, SPLIT_GAP, unsplit, splitWith, withoutPane, reconcile, boxes, isSplit, parseZone,
} from '../core/split';

const sum = (a: number[]): number => a.reduce((x, y) => x + y, 0);

test('an unsplit zone asks for NO inline geometry — the stylesheet keeps owning it', () => {
  /* `boxes` returning null is the signal to CLEAR inline styles, not to write a full-width box.
     Writing one would pin a value `.pane` should own, and the two would drift the next time that
     rule changes. */
  assert.equal(boxes(unsplit(7)), null);
  assert.equal(isSplit(unsplit(7)), false);
});

test('splitting puts the new pane beside the focused one, in order', () => {
  const z = splitWith(unsplit(1), 1, 2);
  assert.deepEqual(z.visible, [1, 2], 'the new pane opens to the RIGHT of the one it was asked beside');
  assert.deepEqual(z.frac, [0.5, 0.5]);
  assert.equal(isSplit(z), true);
});

test('splitting with an already-visible pane is a no-op — the caller just focuses it', () => {
  const z = splitWith({ visible: [1, 2], frac: [0.5, 0.5] }, 1, 2);
  assert.deepEqual(z.visible, [1, 2], 'must not duplicate a pane into both halves');
  assert.equal(splitWith(unsplit(1), 1, 1).visible.length, 1, 'nor split a pane against itself');
});

test('at capacity the NON-focused half is replaced, and the focused pane does not move', () => {
  /* Refusing at capacity is the lazier rule and it reads as a broken gesture. And which half is
     replaced matters: the operator's own work must not jump across the screen, so the pane they
     asked "beside" keeps its side. */
  const right = splitWith({ visible: [1, 2], frac: [0.5, 0.5] }, 1, 3);
  assert.deepEqual(right.visible, [1, 3], 'focused pane was left — it stays left');
  const left = splitWith({ visible: [1, 2], frac: [0.5, 0.5] }, 2, 3);
  assert.deepEqual(left.visible, [3, 2], 'focused pane was right — it stays right');
  assert.ok(right.visible.length <= MAX_VISIBLE);
});

test('closing a pane re-evens what is left, and an empty zone stays empty', () => {
  assert.deepEqual(withoutPane({ visible: [1, 2], frac: [0.3, 0.7] }, 1), { visible: [2], frac: [1] });
  assert.deepEqual(withoutPane(unsplit(1), 1), { visible: [], frac: [] },
    'an empty result is legitimate — inventing a replacement here is how a closed pane resurrects one');
  const untouched = { visible: [1, 2], frac: [0.5, 0.5] };
  assert.equal(withoutPane(untouched, 9), untouched, 'closing an unrelated pane returns the SAME object');
});

test('a restored split drops panes that no longer exist', () => {
  /* The restart case from the spec's test list: the layout persists, the pane ids do not. */
  const z = reconcile({ visible: [1, 2], frac: [0.5, 0.5] }, (id) => id === 2);
  assert.deepEqual(z, { visible: [2], frac: [1] });
  assert.deepEqual(reconcile({ visible: [1, 2], frac: [0.5, 0.5] }, () => false), { visible: [], frac: [] });
});

test('geometry spans the zone exactly, with one gap between the halves', () => {
  const b = boxes({ visible: [1, 2], frac: [0.5, 0.5] }, 10);
  assert.ok(b);
  assert.equal(b.length, 2);
  // outer edges come from the stylesheet's inset; interior edges meet at 50% with half a gap each
  assert.equal(b[0].left, '10px');
  assert.equal(b[1].right, '10px');
  assert.equal(b[0].right, `calc(50% + ${SPLIT_GAP / 2}px)`);
  assert.equal(b[1].left, `calc(50% + ${SPLIT_GAP / 2}px)`);
  /* INTERIOR edges are percentage-based: a split must survive a window resize without
     recomputation, or it carries a width that goes stale the moment the zone changes. The gap
     itself is deliberately in px — a constant separation, not a proportion — so the assertion is
     "the interior edge is proportional", not "no px anywhere". (An earlier form of this line
     forbade `px)` outright and therefore failed on the gap it was written to allow.) */
  assert.match(b[0].right, /^calc\(\d+(\.\d+)?% \+ \d+(\.\d+)?px\)$/, 'left pane ends at a proportion');
  assert.match(b[1].left, /^calc\(\d+(\.\d+)?% \+ \d+(\.\d+)?px\)$/, 'right pane starts at a proportion');
});

test('uneven fractions tile in proportion and still meet', () => {
  const b = boxes({ visible: [1, 2], frac: [0.3, 0.7] }, 10);
  assert.ok(b);
  assert.equal(b[0].right, `calc(70% + ${SPLIT_GAP / 2}px)`, 'left pane ends at 30%');
  assert.equal(b[1].left, `calc(30% + ${SPLIT_GAP / 2}px)`, 'right pane starts at 30% — they meet');
});

test('a corrupt persisted layout degrades to one pane instead of throwing', () => {
  /* localStorage is operator-writable and survives upgrades, so every shape here is reachable. A
     corrupt layout must not stop the window opening. */
  for (const bad of [undefined, null, {}, 'nope', { visible: 'x' }, { visible: [] }, { visible: [null] }]) {
    assert.deepEqual(parseZone(bad, 5), unsplit(5), `${JSON.stringify(bad)} → single pane`);
  }
  assert.deepEqual(parseZone({}, null), { visible: [], frac: [] }, 'no fallback pane → empty, not invented');
});

test('persisted fractions are trusted only when they are complete AND sum to one', () => {
  /* A half-written array is the dangerous case: two panes tiled into 30% of the zone with the
     rest blank looks like a rendering bug, not like bad data. */
  const two = { visible: [1, 2] };
  assert.deepEqual(parseZone({ ...two, frac: [0.3, 0.7] }, null).frac, [0.3, 0.7], 'complete and sums to 1');
  assert.deepEqual(parseZone({ ...two, frac: [0.3] }, null).frac, [0.5, 0.5], 'one fraction for two panes');
  assert.deepEqual(parseZone({ ...two, frac: [0.2, 0.2] }, null).frac, [0.5, 0.5], 'sums to 0.4');
  assert.deepEqual(parseZone({ ...two, frac: [1.4, -0.4] }, null).frac, [0.5, 0.5], 'out-of-range values dropped');
  assert.ok(Math.abs(sum(parseZone({ visible: [1, 2] }, null).frac) - 1) < 1e-9, 'defaults always sum to 1');
});

test('more panes than a zone may show are truncated at parse time', () => {
  const z = parseZone({ visible: [1, 2, 3, 4] }, null);
  assert.equal(z.visible.length, MAX_VISIBLE, 'N>2 is deferred — a persisted 4 must not tile 4');
  assert.equal(z.frac.length, z.visible.length);
});

test('the renderer mirrors this arithmetic, and the duplication is GUARDED', () => {
  /* An earlier form of this test forbade the renderer from computing geometry at all — which is
     impossible: renderer/app.js is a plain <script> and CANNOT import src/core (index.html loads
     UMD bundles, the generated i18n.js and app.js). So the mirror is forced, exactly as it is for
     the busy classifier, and the honest move is to guard it rather than forbid it.
     If either side's constants or formula move, this fails and names both. That is the AI-129
     shape caught before it can drift, not after. */
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  assert.match(app, new RegExp(`const SPLIT_GAP_PX = ${SPLIT_GAP};`),
    `the renderer's gap must equal core's ${SPLIT_GAP}`);
  // the interior-edge formula: start% + half a gap on the left, 100-end% + half a gap on the right
  assert.match(app, /left: i === 0 \? `\$\{PANE_EDGE_PX\}px` : `calc\(\$\{startPct\}% \+ \$\{SPLIT_GAP_PX \/ 2\}px\)`/);
  assert.match(app, /right: i === visible\.length - 1 \? `\$\{PANE_EDGE_PX\}px` : `calc\(\$\{100 - endPct\}% \+ \$\{SPLIT_GAP_PX \/ 2\}px\)`/);
  /* And `.pane`'s own horizontal inset is what PANE_EDGE_PX claims to be — a split whose outer
     edge disagrees with the stylesheet leaves a visible seam only in the split case. */
  const css = fs.readFileSync('renderer/theme.css', 'utf8');
  assert.match(css, /\.pane \{ position: absolute; inset: 0 10px 10px;/, 'the 10px this mirrors');
  assert.match(app, /const PANE_EDGE_PX = 10;/);
});

test('one MECHANISM, two entry points — and the deferred third stays deferred', () => {
  /* The spec says "pick one; do not ship three". Chuy asked for the chord AND the context item,
     which is not a violation: both call a single splitWithPane() and neither needs new geometry,
     so the marginal cost of the second is a menu row. The candidate the spec was warning about is
     dragging a tab into the right half — drop-target hit-testing, widening a drag surface the
     code comments say was deliberately kept to reordering within one strip. */
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  const calls = [...app.matchAll(/splitWithPane\(/g)].length;
  assert.ok(calls >= 3, 'one function, called from its definition and both entry points');
  assert.match(app, /e\.code === 'Backslash'/, 'the chord');
  assert.match(app, /if \(pick === 'right'\) splitWithPane\(z, id\)/, 'the context item');
  /* Drag-to-split is deferred, and the assertion has to say exactly that: this app ALREADY has
     `dragover`/`dataTransfer` for tab reordering and explorer file drops, both older than AI-82,
     so forbidding those words fires on unrelated correct code. (It did — an earlier form of this
     line used a broad alternation and failed on the tab-reorder handler.) What must hold is that
     no DRAG path performs a split: every line that calls splitWithPane is a chord or a menu. */
  const callers = app.split('\n').filter((l) => l.includes('splitWithPane(') && !l.includes('function splitWithPane'));
  assert.equal(callers.length, 2, 'exactly two entry points: the chord and the context item');
  for (const l of callers) {
    assert.doesNotMatch(l, /drag|drop|dataTransfer/i, `a drag path must not split: ${l.trim()}`);
  }
});

test('`active` means FOCUS now, and the focused pane is always visible', () => {
  /* The conflation of "active" and "the only visible one" WAS the ceiling. Keeping ONE focused id
     is what lets every existing consumer of active[z] keep working — AI-64 tied *addressable
     pane* to a single active session and that seam has produced a bug three times, so widening it
     was the change not to make. */
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  assert.match(app, /if \(active\[z\] !== null && panes\.has\(active\[z\]\) && !zones\[z\]\.visible\.includes\(active\[z\]\)\)/,
    'the focused pane must be forced visible, or focus can point at a hidden pane');
  assert.match(app, /p\.tab\.classList\.toggle\('active', pid === active\[z\]\)/, 'active marks focus');
  assert.match(app, /p\.tab\.classList\.toggle\('shown', on\)/, 'shown marks what is on screen');
  /* Clicking a hidden tab while split must SWAP it into the focused half, not collapse the split
     — otherwise every tab click destroys the arrangement the operator just built. */
  assert.match(app, /zones\[z\]\.visible = vis\.map\(\(v, i\) => \(i === at \? id : v\)\)/);
});

test('geometry changes refit the terminals — a pty must never be left at a lie', () => {
  /* This codebase's own rule, from the TUI work: a terminal told the wrong size prints garbage.
     Every path that moves a pane's box therefore ends in fitTerms(), which is already
     rAF-coalesced. The spec's "resize storm" risk is a DRAG concern and the divider is deferred,
     so v1's geometry only moves on discrete events. */
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  const fn = app.slice(app.indexOf('function setVisible(z) {'));
  assert.match(fn.slice(0, fn.indexOf('\nconst evenFrac')), /fitTerms\(\);/,
    'setVisible is the one path all geometry changes go through, so it must refit');
});

test('a closed half hands the whole zone to the survivor, and the layout persists', () => {
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  const fn = app.slice(app.indexOf('function ensureActive(z) {'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /zones\[z\]\.visible = zones\[z\]\.visible\.filter\(\(v\) => ids\.includes\(v\)\)/,
    'filtering keeps the survivor on its own side until it is alone');
  assert.match(body, /saveLayout\(\)/, 'and the change survives a restart');
  assert.match(app, /zoneFrac: \{ main: zones\.main\.frac, term: zones\.term\.frac \}/,
    'fractions are what persist — pane ids do not survive a restart');
});

test('panes tile in TAB ORDER, whatever order the set was built in', () => {
  /* Operator-reported: splitting from the second tab put that pane on the LEFT and the first
     tab's pane on the right, so tabs and panes read in opposite directions. The set is built by
     insertion (beside the focused pane, or replacing the non-focused half), and insertion order
     is not screen order — so it is sorted once in setVisible rather than at each of the three
     places that mutate it. */
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  assert.match(app, /const ord = tabOrder\[z\];\s*\n\s*zones\[z\]\.visible\.sort\(\(a, b\) => ord\.indexOf\(a\) - ord\.indexOf\(b\)\);/,
    'left-to-right on screen must match left-to-right in the strip');
  /* And it must be sorted BEFORE geometry is computed, or the boxes go to the wrong panes. */
  const fn = app.slice(app.indexOf('function setVisible(z) {'));
  assert.ok(fn.indexOf('visible.sort(') < fn.indexOf('const geom = paneBoxes(z)'),
    'sort must precede the geometry it feeds');
});

test('the tab menu is useful on ANY tab — including the one you are looking at', () => {
  /* Reported as "right click didn't work": the split action was offered only for a tab NOT in the
     visible set, so right-clicking the pane you were looking at produced a menu whose only row
     said "open a second one". A menu that depends on the tab being in the right state reads as
     broken, so every row that can apply to the tab under the cursor is offered. */
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  const menu = app.slice(app.indexOf("tab.addEventListener('contextmenu'"), app.indexOf('/* ── drag to reorder'));
  assert.match(menu, /value: 'rename'/, 'rename is always available (AI-70)');
  assert.match(menu, /if \(id !== active\[z\]\) items\.push/, 'split is offered for any non-focused tab');
  assert.match(menu, /value: 'close'/);
  assert.doesNotMatch(menu, /!zones\[z\]\.visible\.includes\(id\)/,
    'the old visibility condition is what made the menu look dead');
});

test('AI-70: a manual tab name outranks the title the session announces', () => {
  /* The two fixes that shipped in v0.7.0 both depend on the session announcing a title, so a pane
     the operator deliberately labelled would be renamed back on the next announcement — silently
     undoing the label they just set. Naming is cosmetic, so the operator's choice wins.
     DELIVERABILITY is untouched: that needs proof, and a label is not proof. */
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  assert.match(app, /pane\.manualName = true; renamePane\(id, next\.trim\(\)\);/, 'the menu sets the flag');
  assert.match(app, /if \(!panes\.get\(id\)\?\.manualName\) renamePane\(id, nm\);/,
    'and the announced-title path honours it');
  /* The bus path must NOT have been widened by any of this — a name is not a delivery right. */
  const title = app.slice(app.indexOf('term.onTitleChange'));
  assert.match(title.slice(0, 1400), /DELIVERABILITY/, 'the two-questions comment must survive');
});
