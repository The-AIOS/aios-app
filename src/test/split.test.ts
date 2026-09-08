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
  MAX_VISIBLE, SPLIT_GAP, MIN_PANE_PX, fitsAnother, unsplit, splitWith, withoutPane, reconcile, boxes, isSplit, parseZone,
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
  const z = splitWith(unsplit(1), 1, 2, true);
  assert.deepEqual(z.visible, [1, 2], 'the new pane opens to the RIGHT of the one it was asked beside');
  assert.deepEqual(z.frac, [0.5, 0.5]);
  assert.equal(isSplit(z), true);
});

test('splitting with an already-visible pane is a no-op — the caller just focuses it', () => {
  const z = splitWith({ visible: [1, 2], frac: [0.5, 0.5] }, 1, 2, true);
  assert.deepEqual(z.visible, [1, 2], 'must not duplicate a pane into both halves');
  assert.equal(splitWith(unsplit(1), 1, 1, true).visible.length, 1, 'nor split a pane against itself');
});

test('with no ROOM a pane is replaced, and the focused pane does not move', () => {
  /* Refusing is the lazier rule and it reads as a broken gesture. Which pane is evicted matters:
     the operator's own work must not jump across the screen, so the pane they asked "beside"
     keeps its side and the FURTHEST one goes. `room` is measured by the caller — see fitsAnother
     — because a count-based cap wastes a large monitor and ruins a laptop. */
  const right = splitWith({ visible: [1, 2], frac: [0.5, 0.5] }, 1, 3, false);
  assert.deepEqual(right.visible, [1, 3], 'focused pane was left — it stays left, furthest evicted');
  const left = splitWith({ visible: [1, 2], frac: [0.5, 0.5] }, 2, 3, false);
  assert.deepEqual(left.visible, [3, 2], 'focused pane was right — it stays right, furthest evicted');
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
  const z = parseZone({ visible: [1, 2, 3, 4, 5] }, null);
  assert.equal(z.visible.length, MAX_VISIBLE, 'a persisted layout must not exceed the ceiling');
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
  assert.match(app, new RegExp(`const SPLIT_GAP_PX = ${SPLIT_GAP};`), `gap must equal core's ${SPLIT_GAP}`);
  assert.match(app, new RegExp(`const MAX_VISIBLE_PANES = ${MAX_VISIBLE};`), 'ceiling must match core');
  assert.match(app, new RegExp(`const MIN_PANE_PX = ${MIN_PANE_PX};`), 'minimum width must match core');
  assert.match(app, /getBoundingClientRect\(\)\.width/, 'room must be MEASURED, never counted');
  // the interior-edge formula: start% + half a gap on the left, 100-end% + half a gap on the right
  assert.match(app, /left: i === 0 \? `\$\{PANE_EDGE_PX\}px` : `calc\(\$\{startPct\}% \+ \$\{SPLIT_GAP_PX \/ 2\}px\)`/);
  assert.match(app, /right: i === visible\.length - 1 \? `\$\{PANE_EDGE_PX\}px` : `calc\(\$\{100 - endPct\}% \+ \$\{SPLIT_GAP_PX \/ 2\}px\)`/);
  /* And `.pane`'s own horizontal inset is what PANE_EDGE_PX claims to be — a split whose outer
     edge disagrees with the stylesheet leaves a visible seam only in the split case. */
  const css = fs.readFileSync('renderer/theme.css', 'utf8');
  assert.match(css, /\.pane \{ position: absolute; inset: 0 10px 10px;/, 'the 10px this mirrors');
  assert.match(app, /const PANE_EDGE_PX = 10;/);
});

test('one MECHANISM, three entry points — chord, menu, and drag onto a pane', () => {
  /* The spec's "pick one; do not ship three" was about shipping three UNPROVEN mechanisms at
     once, and the row said when the third became safe: drag is "the most discoverable gesture and
     worth revisiting once the tiling and the interaction sweep are proven, at which point it is
     additive instead of a risk multiplier". Both were proven live before it was added, so this is
     the anticipated moment rather than scope creep.
     The earlier version of this test asserted drag stayed deferred — and it FIRED when drag was
     built, which is a guard doing its job: reversing a deliberate deferral should cost a
     deliberate edit. All three still route through one splitWithPane(), which is the invariant
     that actually matters. */
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  assert.match(app, /e\.code === 'Backslash'/, 'the chord');
  /* The menu's entry point, asserted as WIRING rather than as an exact argument. Pinning the
     argument (`splitWithPane(z, id)`) is what made this guard fire on a correct fix: the menu
     had to start splitting the focused tab with its NEIGHBOUR, which changes the argument and
     nothing about the invariant. What matters is that the 'right' pick reaches splitWithPane. */
  assert.match(app, /pick === 'right'\)[^\n]*splitWithPane\(z, /, 'the menu item');
  assert.match(app, /splitWithPane\(zoneOf\(p\), dropped\)/, 'the drag');
  const callers = app.split('\n').filter((l) => l.includes('splitWithPane(') && !l.includes('function splitWithPane'));
  assert.equal(callers.length, 3, 'three entry points, one mechanism');
  /* And the two gestures that split WITHOUT a named pane share one notion of the partner, so
     "the next tab" cannot come to mean two different things. */
  assert.match(app, /function nextTabAfter\(z, id\) \{/, 'one shared partner rule');
  /* The drop target is a PANE, and it must not disturb the two drags that predate it: the strip's
     own reorder (which claims drops on TABS) and the explorer's file-path handler. */
  const drop = app.slice(app.indexOf('function attachPaneDropTarget'));
  assert.match(drop.slice(0, drop.indexOf('\n}')), /ev\.stopPropagation\(\);/,
    "a tab dropped on a pane must never reach the explorer's path handler");
  assert.match(drop, /zoneOf\(dp\) === zoneOf\(p\)/, 'and a tab cannot cross zones by dragging');
  assert.match(app, /attachPaneDropTarget\(p, id\)|attachPaneDropTarget\(paneObj, id\)/);
  // excluding the DEFINITION, whose signature matches the same shape as a call
  const hooks = app.split('\n').filter((l) => l.includes('attachPaneDropTarget(') && !l.includes('function attachPaneDropTarget')).length;
  const regs = [...app.matchAll(/panes\.set\(id, (p|paneObj)\)/g)].length;
  assert.equal(hooks, regs, 'every pane kind is a drop target — a new one must not forget');
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
  /* A NATIVE menu, not the app's searchable picker. listModal exists for long lists and carries a
     filter box; on four rows that reads as over-powered — the operator said so. A search field
     implies a list worth searching. */
  assert.match(menu, /window\.glassShell\.tabMenu\(items\)/, 'the tab menu must be native');
  assert.doesNotMatch(menu, /listModal\(/, 'the searchable picker is the wrong instrument here');
  /* Split is offered on EVERY tab that has something to split with — including the focused one,
     where the partner is its neighbour. Asserted as the capability: the previous version of this
     line pinned `id !== active[z]`, which is exactly the condition that had to change, so the
     guard fired on the fix rather than on a regression. What must hold is that the item's
     presence is decided by whether a partner EXISTS, never by which tab you right-clicked. */
  assert.match(menu, /const partner = /, 'the menu resolves a partner');
  assert.match(menu, /if \(partner !== null\) items\.push/, 'and offers the split whenever one exists');
  assert.doesNotMatch(menu, /if \(id !== active\[z\]\) items\.push/,
    'gating on the tab being unfocused is what left the menu dead on the tab you are looking at');
  assert.match(menu, /value: 'close'/);
  assert.doesNotMatch(menu, /!zones\[z\]\.visible\.includes\(id\)/,
    'the old visibility condition is what made the menu look dead');
});

test('AI-70: renaming is TWO renames — a session renames itself, a shell gets a label', () => {
  /* The operator caught this: renaming a live session's tab changed only the tab, leaving the tab
     saying one thing while the registry said another. That is not cosmetic — the bus addresses
     sessions BY NAME and `/rename` rewrites the registry entry, so the two disagreeing is the
     class that produced the earlier crash-adjacent weirdness. A session must rename ITSELF
     through the dance that already works, and `manualName` must NEVER be set on one, or it blocks
     the forward dance and re-creates the mismatch from the other side. */
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  const menu = app.slice(app.indexOf("tab.addEventListener('contextmenu'"), app.indexOf('/* ── drag to reorder'));
  assert.match(menu, /if \(pane\.isSession && !pane\.exited\) \{\s*\n\s*submitToPty\(id, '\/rename ' \+ next\);/,
    'a live session is asked to rename itself');
  const manual = menu.slice(menu.indexOf('} else {'));
  assert.match(manual, /pane\.manualName = true;\s*\n\s*renamePane\(id, next\);/,
    'and only the non-session branch labels the tab directly');
  assert.ok(menu.indexOf("submitToPty(id, '/rename") < menu.indexOf('pane.manualName = true'),
    'the session branch must come FIRST — a session must never reach the manual-label path');
  assert.match(app, /if \(!panes\.get\(id\)\?\.manualName\) renamePane\(id, nm\);/,
    'and the announced-title path honours it');
  /* The bus path must NOT have been widened by any of this — a name is not a delivery right. */
  const title = app.slice(app.indexOf('term.onTitleChange'));
  assert.match(title.slice(0, 1400), /DELIVERABILITY/, 'the two-questions comment must survive');
});

test('the ceiling is WIDTH, not count — measured against the zone in front of the operator', () => {
  /* The operator asked why two. The honest answer: nothing in the geometry required it — boxes()
     and setVisible were always N-general — and the two-cap was itself the reported bug, because
     the replace-at-capacity rule evicted panes by a policy that looked arbitrary with three tabs.
     A count cap is the wrong instrument in both directions: it wastes a 34" monitor and ruins a
     laptop. So the gate is whether every pane stays usable at ~40 columns. */
  assert.equal(fitsAnother(1, 1400), true, 'two panes fit a normal window');
  assert.equal(fitsAnother(2, 1400), true, 'and three fit a wide one');
  assert.equal(fitsAnother(2, 800), false, 'but not a narrow one — 3 x 320 does not fit 800');
  assert.equal(fitsAnother(1, 600), false, 'nor two in a very narrow zone');
  assert.equal(fitsAnother(MAX_VISIBLE, 100000), false, 'the ceiling still holds on any monitor');
  /* The gap is charged for: n panes have n-1 gaps between them, so the usable width shrinks as
     panes are added. Forgetting that is how the last pane ends up a few px narrower than the min. */
  const wide = MIN_PANE_PX * 2 + SPLIT_GAP;
  assert.equal(fitsAnother(1, wide), true, 'exactly enough for two plus one gap');
  assert.equal(fitsAnother(1, wide - 1), false, 'one px short is short');
});

test('reordering the strip reorders the split — free, because order is DERIVED', () => {
  /* The nicest property of the design, and worth stating so nobody "optimises" it away: the
     split keeps no order of its own. `visible` is sorted by tabOrder in setVisible, so dragging a
     tab past another re-tiles the panes with no second list to keep in step — and no second way
     for the two to disagree. All moveTab has to do is ask for a re-layout. */
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  const fn = app.slice(app.indexOf('function moveTab(z, dragId, overId, after) {'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /setVisible\(z\);/, 'a reorder must re-lay-out, or the panes keep the old order');
  assert.match(body, /saveLayout\(\);/, 'and the new order must survive a restart');
  /* The split must NOT carry its own order field — that is what makes the above sufficient. */
  assert.doesNotMatch(app, /zones\[z\]\.order|visibleOrder/, 'pane order is derived, never stored');
});

test('clicking INSIDE a pane moves the marks, not just the caret', () => {
  /* Operator-reported: with two terminals split, clicking the other one moved the cursor but left
     the tab highlight and the focus ring on the first. That is worse than having no indicator —
     the two marks that exist to answer "where do my keystrokes land" were pointing at the wrong
     pane. It is the half of the spec's focus semantics that was missing: `active` became "focused
     rather than the only visible one", and nothing told it when focus moved by CLICK. */
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  assert.match(app, /p\.el\.addEventListener\('mousedown', \(\) => focusPane\(id\), true\)/,
    'a click in a pane must focus it — mousedown, and capture, so the marks land with the caret');
  const fn = app.slice(app.indexOf('function focusPane(id) {'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  /* A click must cost nothing when it lands where focus already is, and must NOT refit: nothing
     has moved, so a geometry pass would be a pty resize push for free. */
  assert.match(body, /if \(active\[z\] === id\) return;/, 'a click on the focused pane is free');
  assert.doesNotMatch(body, /fitTerms\(\)|paneBoxes\(/, 'no geometry work — nothing moved');
  /* But a HIDDEN pane cannot take the shortcut: entering the visible set IS a geometry change. */
  assert.match(body, /if \(!zones\[z\]\.visible\.includes\(id\)\) \{ setActive\(id\); return; \}/,
    'a hidden pane must take the full path');
  assert.match(body, /q\.tab\.classList\.toggle\('active', pid === id\)/, 'the tab mark follows');
  assert.match(body, /q\.el\.classList\.toggle\('panefocus', split && pid === id\)/, 'and the pane ring');
});

test('a NEW pane never evicts a split — it joins if it fits, else takes the zone', () => {
  /* Operator-reported: with a zone split, opening another terminal or session "replaces the
     rightmost screen without checking if there was room". That is the worst of the three
     available outcomes — one of the two things they were deliberately watching disappeared, and
     nothing said so. The other two are both honest: join when the zone can still fit a usable
     pane, otherwise take the zone full and leave the split's members as tabs (⌘\ brings the pair
     straight back). Both are announced.
     Guarded as CAPABILITY, not as source lines: the decision must be measured, gated on a fresh
     pane, and must never reach for the eviction shape. */
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  const fn = app.slice(app.indexOf('function homePane(id, p, { fresh = false } = {}) {'));
  const body = fn.slice(0, fn.indexOf('\n}'));

  /* MEASURED. The ceiling is width — the same rule as fitsAnother() — so the answer differs
     between a laptop and a 34" monitor and cannot be a constant. */
  assert.match(body, /getBoundingClientRect\(\)\.width/, 'the zone must be measured, never assumed');
  assert.match(body, /MIN_PANE_PX/, 'and compared against the narrowest usable pane');
  assert.match(body, /SPLIT_GAP_PX/, 'with the gaps charged for');

  /* GATED ON `fresh`. applySplit() re-homes every pane on every layout change; a re-home that
     re-decided the arrangement would rearrange the zone on an unrelated repaint. */
  assert.match(body, /if \(fresh &&/, 'only a fresh pane may decide placement');

  /* BOTH OUTCOMES EXIST, AND BOTH SPEAK. */
  assert.match(body, /toast\(t\('split\.joined'\)\)/, 'joining must be announced');
  assert.match(body, /toast\(t\('split\.tookRight'\)\)/, 'so must taking the rightmost slot');

  /* NO ROOM TAKES ONE SLOT, NEVER THE ZONE. Operator's decision, and the reasoning is that
     answering "one more terminal" by removing two is a bigger change than the request. The
     first implementation took the whole zone and they rejected it on exactly that ground. */
  assert.doesNotMatch(body, /zones\[z\]\.visible = \[id\]/, 'a new pane must not take the whole zone');
  assert.match(body, /\.filter\(\(v\) => v !== rightmost\)/, 'it replaces the rightmost pane only');

  /* RIGHTMOST IS BY TAB ORDER, not by array position — `visible` is sorted by tabOrder in
     setVisible, so the array's last element is not necessarily the pane on the right. Reading
     the array end would evict a pane the operator sees in the middle. */
  assert.match(body, /ord\.indexOf\(a\) - ord\.indexOf\(b\)/, 'rightmost must be resolved by tab order');

  /* And the fractions must SURVIVE: the pane count does not change, so re-evening them would
     discard a splitter the operator had dragged. */
  const noRoom = body.slice(body.indexOf('} else {'));
  assert.doesNotMatch(noRoom, /frac = evenFrac/, 'a same-count replacement must not re-even the split');

  /* FOCUS MUST MOVE WITH THE DECISION, and this is not cosmetic. setVisible forces the focused
     pane visible by COLLAPSING the zone to it. If focus were left on the pane that was just
     replaced, setVisible would answer by collapsing to one pane — undoing the arrangement this
     branch decided. Measured, not reasoned: the live window reported visible=[3] where [1,3]
     was intended, until this assignment was added.
     Asserted by ORDER, because the position is the whole point: inside the fresh block, and
     before the setVisible that would otherwise collapse it. */
  const freshAt = body.indexOf('if (fresh &&');
  const focusAt = body.indexOf('active[z] = id;');
  const visibleAt = body.indexOf('setVisible(z);');
  assert.ok(freshAt >= 0 && focusAt > freshAt, 'focus must move inside the fresh-placement branch');
  assert.ok(visibleAt > focusAt, 'and BEFORE setVisible, which collapses the zone to the focused pane');

  /* The placement is an arrangement change, so it must survive a restart. */
  assert.match(body, /saveLayout\(\)/, 'the new arrangement must persist');

  /* And the two messages must actually exist. */
  const en = JSON.parse(fs.readFileSync('src/i18n/locales/en.json', 'utf8')) as Record<string, string>;
  for (const k of ['split.joined', 'split.tookRight']) {
    assert.ok(en[k], `missing i18n key ${k} — the toast would render its own key at the operator`);
  }
});

test('the tab menu can always split — including on the tab you are looking at', () => {
  /* Operator-reported TWICE. First: "right click, open second one to split, didn't work" — the
     item was offered only for a tab that was not the focused one. Fixed once, then it regressed
     for a new reason: a zone that goes full makes the focused tab the ONLY visible one, so the
     tab you are most likely to right-click was again the one with nothing to offer.
     The fix is not a looser condition, it is a shared notion of WHO to split with when the
     operator has not named a pane — the next tab in the strip, which is exactly what the chord
     already meant. One helper, both gestures, so they cannot drift. */
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  const fn = app.slice(app.indexOf('function nextTabAfter(z, id) {'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  assert.match(body, /order\.length < 2/, 'a zone with one pane has no partner — say null, not a guess');
  assert.match(body, /\(at \+ 1\) % order\.length/, 'the partner is the NEXT tab, wrapping');

  /* BOTH entry points must go through it — that is the whole point of extracting it. */
  const uses = app.match(/nextTabAfter\(/g) || [];
  assert.ok(uses.length >= 3, `the chord and the menu must both use it (definition + 2 callers), saw ${uses.length}`);

  /* The menu must NOT gate the split item on the tab being unfocused. */
  assert.doesNotMatch(app, /if \(id !== active\[z\]\) items\.push/,
    'gating the split item on an unfocused tab is what made the menu look dead');
  assert.match(app, /const partner = id === active\[z\] \? nextTabAfter\(z, id\) : id;/,
    'the focused tab splits with its neighbour; any other tab splits with itself');
});
