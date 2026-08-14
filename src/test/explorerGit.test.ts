/**
 * Section-level git rollup (FRAMEWORK / VAULT).
 *
 * The invariant worth guarding is scope, not rendering: the vault lives INSIDE the
 * framework root, and the framework TREE skips it (buildTree's skipName). If the
 * rollup doesn't skip it too, a vault-only edit lights up FRAMEWORK — a marker that
 * points at the wrong place is worse than no marker, and it fails silently because
 * the count still looks plausible.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

const app = fs.readFileSync('renderer/app.js', 'utf8');
const css = fs.readFileSync('renderer/theme.css', 'utf8');

test('FRAMEWORK declares the vault as an exclusion; VAULT declares none', () => {
  assert.match(app, /key: 'FRAMEWORK'[^}]*gitRoot: roots\.framework, gitExclude: roots\.vault/);
  const vaultCall = /key: 'VAULT'[^}]*\}/.exec(app);
  assert.ok(vaultCall, 'VAULT section must exist');
  assert.match(vaultCall[0], /gitRoot: roots\.vault/);
  assert.doesNotMatch(vaultCall[0], /gitExclude/, 'the vault is a leaf scope — nothing to exclude');
});

test('the rollup actually applies the exclusion, not just receives it', () => {
  // The containment test moved into the shared `xUnder` helper when Windows arrived (backslash
  // paths never matched a `+ '/'` test). Assert that the rollup DELEGATES to it rather than
  // re-deriving a prefix check of its own — a second implementation is how the two drift.
  assert.match(app, /const inExcl = \(p\) => !!excl && xUnder\(p, excl\);/);
  assert.match(app, /if \(!inRoot\(p\) \|\| inExcl\(p\)\) continue;/);
});

test('prefix tests are path-boundary safe — a sibling named like the root must not match', () => {
  /* This used to pin the literal `p === root || p.startsWith(root + '/')`. Windows made that
     spelling wrong (backslash paths) and the assertion failed on a CORRECT change — so it now
     tests the BEHAVIOUR of the helper that owns the rule, which is what the title always claimed.
     Extracted and executed rather than pattern-matched: a boundary bug is invisible to a regex
     that only checks the code still looks a certain way. */
  const m = /^const xUnder = .+$/m.exec(app);   // whole LINE — its body contains semicolons
  assert.ok(m, 'the shared containment helper must be findable');
  const xUnder = new Function(`${m[0]} return xUnder;`)() as (c: string, p: string) => boolean;

  // inside → true, on both separators
  assert.equal(xUnder('/a/vault', '/a/vault'), true, 'the root is inside itself');
  assert.equal(xUnder('/a/vault/notes/x.md', '/a/vault'), true);
  assert.equal(xUnder('C:\\a\\vault\\notes\\x.md', 'C:\\a\\vault'), true, 'backslash paths must match');
  // the actual bug this guards: a SIBLING that merely shares the prefix
  assert.equal(xUnder('/a/vault-archive', '/a/vault'), false, 'a sibling named like the root must NOT match');
  assert.equal(xUnder('/a/vault-archive/secret.md', '/a/vault'), false);
  assert.equal(xUnder('C:\\a\\vault-archive\\secret.md', 'C:\\a\\vault'), false, 'and not on Windows either');
});

test('rollup runs on every git refresh, so it cannot drift from the rows', () => {
  assert.match(app, /applySectionGit\(GIT\.files\);\n\}/, 'called at the end of applyGit, off the same cached snapshot the rows use');
  assert.match(app, /function applySectionGit\(files\)/);
});

test('a cleared scope removes its badge instead of showing a stale count', () => {
  assert.match(app, /if \(!n\) \{ if \(badge\) badge\.remove\(\); return; \}/);
});

test('the badge reuses the dirty-folder gold, and keeps the sort control rightmost', () => {
  assert.match(css, /\.xsectgit \{[^}]*color: var\(--st-warn\)/);
  assert.match(css, /\.xsectgit \{[^}]*tabular-nums/, 'digits must not jitter as the count grows');
  assert.match(app, /if \(sort\) head\.insertBefore\(badge, sort\); else head\.appendChild\(badge\);/);
});

test('the tooltip label exists in every locale with its count placeholder', () => {
  for (const loc of ['en', 'es', 'pt-br']) {
    const j = JSON.parse(fs.readFileSync(`src/i18n/locales/${loc}.json`, 'utf8')) as Record<string, string>;
    assert.ok(j['explorer.gitPending'], `${loc} must define explorer.gitPending`);
    assert.match(j['explorer.gitPending'], /\{n\}/, `${loc} must interpolate the count`);
  }
});

/* ── marker latency ───────────────────────────────────────────────────────────
   Expanding a folder builds fresh rows. They used to carry no git state until the
   next poll landed, so a folder could look clean for up to 4s after opening it. */

test('rows are painted at creation from the cached snapshot, not on the next poll', () => {
  assert.match(app, /paintRowGit\(row\); \/\/ from cache/, 'makeRow must paint at birth');
  assert.match(app, /let GIT = \{ files: \{\}, dirty: new Set\(\), repos: \[\] \};/);
  assert.match(app, /GIT = \{ files: files \|\| \{\}, dirty: new Set\(dirtyList \|\| \[\]\), repos: repos \|\| \[\] \};/,
    'every refresh must update the cache the birth-paint reads');
});

test('GIT is declared before its first caller — `let` has no hoisting', () => {
  assert.ok(app.indexOf('let GIT = {') < app.indexOf('function makeRow'),
    'makeRow calls paintRowGit, which reads GIT; declaring it later is a TDZ crash on first paint');
});

test('exactly ONE place writes a git marker — two copies would drift', () => {
  const writes = app.match(/row\.classList\.add\('g' \+ code\)/g) || [];
  assert.equal(writes.length, 1, `expected a single decider, found ${writes.length}`);
  const strips = app.match(/classList\.remove\('gM', 'gU', 'gA', 'gD', 'gR'\)/g) || [];
  assert.equal(strips.length, 1, 'and a single place that clears stale classes');
});

test('an expand also confirms against fresh status, so cache staleness self-heals', () => {
  const expands = app.match(/await buildTree\([^)]*\); refreshGit\(\);/g) || [];
  assert.equal(expands.length, 2, 'both the tree and workspace-root expanders refresh');
});

test('the dead e.git entry field is gone — fs:list never populated it', () => {
  assert.doesNotMatch(app, /e\.git/, 'a vestigial second source of truth invites drift');
});

/* ── explorer → terminal / editor wiring ─────────────────────────────────────── */

test('"open terminal here" actually reaches the pty as a cwd', () => {
  // main validated and honoured `cwd` all along; the renderer's destructure dropped it, so
  // every "open terminal here" silently landed in the framework root instead
  assert.match(app, /async function createPane\(\{ name = 'terminal', cmd, cwd, bypassReady = false \} = \{\}\)/);
  // Asserts the INTENT (cwd reaches the pty), not the literal argument list — the list grew
  // a `name` for AI-64 and a shape-exact regex made an unrelated test fail.
  assert.match(app, /ptySpawn\(\{[^}]*\bcwd\b[^}]*\}\)/);
  assert.match(app, /void createPane\(\{ name: xBase\(dir\) \|\| 'terminal', cwd: dir \}\)/);
});

test('a dragged row carries its own is-directory flag, so no drop needs to ask again', () => {
  assert.match(app, /ev\.dataTransfer\.setData\('application\/x-aios-path', p\)/);
  assert.match(app, /if \(isDir\) ev\.dataTransfer\.setData\('application\/x-aios-dir', '1'\)/);
  assert.match(app, /const draggedIsDir = /);
  // Glass sets dragstart only — a webview cannot receive the drop. We can, so we do.
  assert.match(app, /function attachDropZone/);
  assert.match(app, /attachDropZone\(document\.getElementById\('panes'\)/, 'editor zone opens the file');
  assert.match(app, /attachDropZone\(document\.getElementById\('tpanes'\)/, 'terminal zone inserts the path');
  assert.match(app, /attachDropZone\(el, \(paths\) =>/, 'and each terminal pane accepts its own drop');
});

test('a dropped path is INSERTED, never submitted', () => {
  // it is the start of a command the operator is still writing
  const drops = app.match(/ptyWrite\(id, paths\.map\(xQuote\)\.join\(' '\) \+ ' '\)/g) || [];
  assert.ok(drops.length >= 2, 'both the pane and zone handlers insert with a trailing space');
  assert.doesNotMatch(app, /submitToPty\([^)]*(dropped|paths)/, 'a drop must not press Enter');
});

test('a pty resize is pushed ONLY when the grid changed', () => {
  // measured: a 40px splitter drag fired 40 fitTerms→resize calls with the geometry
  // unchanged on 39 of them, and every resize repaints the session's whole TUI — which is
  // what read as the statusline "updating weirdly". After: 3 pushes for 3 real row changes.
  assert.match(app, /function pushPtyGeom\(id, p\)/);
  assert.match(app, /if \(g === p\.lastGeom\) return false;/);
  const senders = app.match(/glassShell\.ptyResize\(/g) || [];
  assert.equal(senders.length, 1, 'exactly one place may send a resize — pushPtyGeom');
});

test('an external (Finder) drop resolves paths via webUtils, not File.path', () => {
  const pre = fs.readFileSync('src/preload/preload.ts', 'utf8');
  // Electron REMOVED File.path in v32 (we are on 42), so the first cut's
  // `ev.dataTransfer.files[0].path` was dead code: a Finder drop looked supported and did
  // nothing. webUtils.getPathForFile is the only way to resolve it.
  assert.match(pre, /webUtils\.getPathForFile\(f\)/);
  assert.doesNotMatch(app, /files\?\.\[0\]\?\.path/, 'the dead File.path fallback is gone');
  assert.match(app, /\[\.\.\.\(dt\.files \|\| \[\]\)\]\.map\(\(f\) => window\.glassShell\.pathForFile\(f\)\)\.filter\(Boolean\)/);
  // Finder can hand over several files at once; our own rows never do
  assert.match(app, /paths\.map\(xQuote\)\.join\(' '\)/, 'multi-file drops insert every path');
});

test('a dropped OUTSIDE folder becomes a workspace folder rather than a dead end', () => {
  const main = fs.readFileSync('src/main/main.ts', 'utf8');
  // the dialog-based add cannot take a path we were handed, and an external drop is the
  // natural way to bring an outside project in
  assert.match(main, /ipcMain\.handle\('fs:addFolderPath'/);
  assert.match(main, /if \(!fs\.statSync\(abs\)\.isDirectory\(\)\) return null;/, 'must be a real directory');
  assert.match(app, /window\.glassShell\.addFolderPath\(dropped\)/);
});

test('drop targets announce themselves for the WHOLE drag, not only on hover', () => {
  // otherwise you only discover a target by finding it, which was the report
  assert.match(app, /document\.body\.classList\.toggle\('dragging', dragDepth > 0\)/);
  assert.match(app, /window\.addEventListener\('dragenter'/);
  assert.match(app, /window\.addEventListener\('dragend'/, 'and it must always clear');
  assert.match(css, /body\.dragging #panes::after, body\.dragging #tpanes::after \{ display: flex; \}/);
  // drawn in an overlay: a real border would resize the terminal grid mid-drag
  assert.match(css, /#panes::after, #tpanes::after \{[\s\S]*?position: absolute;/);
  for (const loc of ['en', 'es', 'pt-br']) {
    const j = JSON.parse(fs.readFileSync(`src/i18n/locales/${loc}.json`, 'utf8')) as Record<string, string>;
    assert.ok(j['drop.hintEditor'] && j['drop.hintTerminal'] && j['drop.folderAdded'], `${loc} drop strings`);
  }
});

test('the drop accept-test reads TYPES, never getData — dragover is protected', () => {
  // During dragover the DataTransfer is in protected mode by spec: types is readable but
  // getData() returns ''. Testing getData there made the accept test always false, so
  // preventDefault was never called and the browser rejected every drop — the zone lit up
  // (that comes from the window-level dragenter) and releasing did nothing.
  assert.match(app, /const DROP_TYPES = \['application\/x-aios-path', 'text\/uri-list', 'text\/plain', 'Files'\];/);
  // Intent, not layout: the accept test must READ types and must not call getData. Pinning
  // the two lines as ADJACENT broke when a tab-drag guard was inserted between them.
  assert.match(app, /const ok = \(ev\) => \{[\s\S]{0,400}?ev\.dataTransfer\?\.types[\s\S]{0,400}?types\.some\(/, 'ok() must read dataTransfer.types');
  const okBody = /const ok = \(ev\) => \{([\s\S]*?)\n  \};/.exec(app)?.[1] ?? '';
  assert.ok(okBody.length > 0, 'ok() body must be findable');
  assert.doesNotMatch(okBody, /getData/, 'ok() must never call getData — protected mode returns \'\' by spec');
  assert.doesNotMatch(app, /const ok = \(ev\) => !!draggedPath\(ev\)/, 'the getData-based test is gone');
});

test('a tab reorder drag never arms the file drop zones', () => {
  // A tab drag is a drag, and the window-level dragenter lit both zones for ANY drag — so
  // reordering a tab offered two drop targets that could never accept it.
  assert.match(app, /const isTabDrag = \(ev\) =>[\s\S]{0,200}?application\/x-aios-tab/, 'a tab-drag test must exist');
  assert.match(app, /dragenter', \(ev\) => \{ if \(!isTabDrag\(ev\)\) setDragging\(true\); \}\)/, 'the window dragenter must skip tab drags');
  assert.match(app, /if \(types\.includes\('application\/x-aios-tab'\)\) return false;/, 'the zone accept-test must refuse tab drags explicitly');
  assert.match(app, /tab\.draggable = true/, 'tabs must be draggable');
});

test('the drop overlay lands where pane content begins', () => {
  // .pane uses inset: 0 10px 10px; an 8px box outlined the wrong area
  assert.match(css, /position: absolute; inset: 0 10px 10px; z-index: 40;/);
});

test('emoji are two cells wide — the statusline depends on it', () => {
  // Measured: every statusline emoji is width 1 under xterm's default Unicode 6 tables and 2
  // under 11, so a four-emoji statusline is 4 cells adrift from what the writer intended and
  // renders mis-spaced (📁obsidian for 📁 obsidian).
  assert.match(app, /allowProposedApi: true/, 'required before a width table can be selected');
  assert.match(app, /term\.unicode\.activeVersion = '11'/);
  assert.match(app, /Unicode11Addon/);
  const indexHtml = fs.readFileSync('renderer/index.html', 'utf8');
  assert.match(indexHtml, /addon-unicode11/, 'the addon has to be loaded in the page');
  // and an emoji font, since no mono face carries these glyphs
  assert.match(app, /'Apple Color Emoji'/);
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8')) as { dependencies: Record<string, string> };
  assert.ok(pkg.dependencies['@xterm/addon-unicode11'], 'must be a real dependency, not just loaded');
});

test('OS drops resolve File objects BEFORE text/plain — Finder puts a URL there', () => {
  // A Finder drag populates text/plain with a file:// URL, not a path. Preferring text/plain
  // handed that URL to the opener (which failed) and never reached the File branch that
  // webUtils actually resolves — which is why Finder → editor did nothing.
  const order = app.slice(app.indexOf('function droppedPaths'), app.indexOf('function droppedPaths') + 1400);
  const iOwn = order.indexOf("getData('application/x-aios-path')");
  const iFiles = order.indexOf('pathForFile');
  const iPlain = order.indexOf("getData('text/plain')");
  assert.ok(iOwn < iFiles && iFiles < iPlain, 'ours → File objects → URI text, in that order');
  /* And a file:// URL must be DECODED, not passed through. The inline ternary this used to pin
     became `fileUrlToPath` when Windows arrived (a drive path needs the leading slash stripped and
     the separators flipped), so assert the conversion's behaviour instead of its spelling. */
  const fm = /function fileUrlToPath\(u\) \{[\s\S]*?\n\}/.exec(app);
  assert.ok(fm, 'the file:// converter must be findable');
  const make = (isWin: boolean) =>
    new Function('IS_WIN', `${fm![0]} return fileUrlToPath;`)(isWin) as (u: string) => string;
  const posix = make(false);
  assert.equal(posix('file:///Users/x/My%20Notes/a.md'), '/Users/x/My Notes/a.md', 'percent-decoded');
  assert.equal(posix('/already/a/path.md'), '/already/a/path.md', 'a plain path passes through untouched');
  const win = make(true);
  assert.equal(win('file:///C:/a/My%20Notes/b.md'), 'C:\\a\\My Notes\\b.md',
    'drive path: leading slash dropped, separators flipped, still decoded');
  assert.match(app, /filter\(\(u\) => u && !u\.startsWith\('#'\)\)/, 'uri-list comments are not paths');
});

test('a dropped file outside every root widens scope instead of dead-ending', () => {
  // inAllowed restricts reads to the framework, vault and workspace folders — so most things
  // dragged from Finder are unreadable. Adding the parent folder is the same widening the
  // Add-folder dialog does; the drop is the consent, and it shows up removable in the tree.
  assert.match(app, /const readable = await window\.glassShell\.fsRead\(dropped\)\.catch/);
  assert.match(app, /const parent = xDirOf\(dropped\);/);
  assert.match(app, /const widened = await window\.glassShell\.addFolderPath\(parent\)/);
});

test('drop markers clear after an EXTERNAL drop, which never sends dragend', () => {
  // dragend only fires on the element a drag STARTED from, so a Finder drag never produces
  // one — `drop` is the only signal. And it must be a CAPTURE listener, because the zone
  // handlers call stopPropagation (so a drop on a terminal pane does not also run its zone's
  // handler), which would otherwise block this cleanup and leave the markers on screen.
  assert.match(app, /window\.addEventListener\('drop', clearDragging, true\);/);
  assert.match(app, /window\.addEventListener\('dragend', clearDragging\);/);
  // leaving the window without dropping must clear too
  assert.match(app, /window\.addEventListener\('dragleave', \(ev\) => \{ if \(!ev\.relatedTarget\) clearDragging\(\); \}\);/);
  // and the zone clears its own state where the drop is actually handled
  assert.match(app, /elm\.classList\.remove\('dropok'\);\n\s*clearDragging\(\);/);
});
