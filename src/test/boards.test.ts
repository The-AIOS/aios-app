/** #91 — sidebar boards: the pure rules, the protocol handler against a real folder, and the card's frame. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  boardRows, parseBoardJson, boardRelPath, boardCsp, boardId, boardUrl, boardOrigin,
  boardNavigationAllowed, isBoardName, DEFAULT_VALID_FOR_S,
} from '../core/boards';
import { listBoards, serveBoardRequest } from '../main/boards';

const NOW = Date.parse('2026-11-02T21:00:00Z');
const MIN = 60_000;

test('a folder is a board only with an index.html; dot-folders and odd names never are', () => {
  const rows = boardRows([
    { name: 'status', indexMtimeMs: NOW - 5 * MIN },
    { name: 'empty' },                                   // no index.html
    { name: '.hidden', indexMtimeMs: NOW },
    { name: 'a/b', indexMtimeMs: NOW },
  ], NOW);
  assert.deepEqual(rows.map((r) => r.name), ['status']);
  assert.equal(isBoardName('..'), false);
  assert.equal(isBoardName('My Board'), true, 'a folder name is a title, not an identifier: spaces and capitals are fine');
});

test('title and valid_for come from board.json; defaults are the folder name and one hour', () => {
  const [plain, titled] = boardRows([
    { name: 'a', indexMtimeMs: NOW - 59 * MIN },
    { name: 'b', indexMtimeMs: NOW - 59 * MIN, boardJson: JSON.stringify({ title: 'Queue', valid_for: 600 }) },
  ], NOW);
  assert.equal(plain.title, 'a');
  assert.equal(plain.validForS, DEFAULT_VALID_FOR_S);
  assert.equal(plain.status, 'fresh');
  assert.equal(titled.title, 'Queue');
  assert.equal(titled.status, 'stale', '59 minutes old against a 10-minute valid_for');
});

test('stale is drawn when index.html is older than valid_for, and only then', () => {
  const [fresh, stale] = boardRows([
    { name: 'a', indexMtimeMs: NOW - DEFAULT_VALID_FOR_S * 1000 },
    { name: 'b', indexMtimeMs: NOW - DEFAULT_VALID_FOR_S * 1000 - 1 },
  ], NOW);
  assert.equal(fresh.status, 'fresh');
  assert.equal(stale.status, 'stale');
});

test('a broken board.json is reported on the card, never a reason to hide the board', () => {
  const [r] = boardRows([{ name: 'a', indexMtimeMs: NOW, boardJson: '{ nope' }], NOW);
  assert.equal(r.title, 'a');
  assert.match(r.configError || '', /board\.json/);
  assert.match(parseBoardJson('{"valid_for": -1}').error || '', /valid_for/);
  assert.match(parseBoardJson('{"title": 3}').error || '', /title/);
  assert.deepEqual(parseBoardJson('{"title":"x","later_field":1}'), { title: 'x' }, 'unknown keys are room for later, not an error');
});

test('each board is its own origin, and a changed file is a new URL', () => {
  assert.notEqual(boardId('a'), boardId('A'), 'case matters, although standard-scheme hosts are lower-cased');
  assert.match(boardId('Any name / with ü'), /^[0-9a-f]{32}$/);
  assert.equal(boardUrl('a', 1000), `${boardOrigin('a')}/index.html?v=1000`);
  assert.notEqual(boardUrl('a', 1000), boardUrl('a', 2000));
});

test('the CSP blocks everything but the board\'s own images, styles and fonts, and sandboxes the page', () => {
  const csp = boardCsp('a');
  const own = boardOrigin('a');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /(^|; )sandbox($|;)/);
  for (const d of ['img-src', 'style-src', 'font-src']) {
    const v = csp.split('; ').find((x) => x.startsWith(d + ' '))!;
    assert.ok(v.includes(own), `${d} allows the board's origin`);
    assert.ok(!/\*|https?:|file:|'self'/.test(v), `${d} allows nothing else: ${v}`);
  }
  assert.ok(!/script-src|connect-src|frame-src|'unsafe-eval'/.test(csp), 'no directive re-opens what default-src closed');
});

test('request paths: only static assets, no dot-segments, no dot-files, no backslashes', () => {
  assert.equal(boardRelPath('/'), 'index.html');
  assert.equal(boardRelPath('/img/a.png'), 'img/a.png');
  for (const bad of ['/../x.png', '/a/%2e%2e/x.png', '/.git/config.css', '/a\\b.png', '/x.js', '/x.json', '/x', '/%E0%A4%A.png', '//x.png']) {
    assert.equal(boardRelPath(bad), null, bad);
  }
});

test('navigation: a board frame may only reload its own page; only the App\'s page may put a board in a frame', () => {
  const a = boardUrl('a', 1), a2 = boardUrl('a', 2), b = boardUrl('b', 1);
  const card = { frameIsChildOfTop: true, initiatorIsTop: true };
  assert.equal(boardNavigationAllowed('about:blank', a, card), true, 'the card mounting its frame');
  assert.equal(boardNavigationAllowed('about:blank', a, { frameIsChildOfTop: false, initiatorIsTop: false }), false,
    'a page in the HTML viewer creating its own frame and pointing it at a board');
  assert.equal(boardNavigationAllowed('about:blank', a, { frameIsChildOfTop: true, initiatorIsTop: false }), false,
    'a direct child of the App\'s page navigating ITSELF into a board (the HTML viewer\'s own frame)');
  assert.equal(boardNavigationAllowed('about:blank', a), false, 'no context, no entry');
  assert.equal(boardNavigationAllowed(a, a2), true, 'the card reloading a changed board');
  assert.equal(boardNavigationAllowed(a, 'https://example.com/'), false);
  assert.equal(boardNavigationAllowed(a, 'file:///etc/hosts'), false);
  assert.equal(boardNavigationAllowed(a, b), false, 'one board into another');
  assert.equal(boardNavigationAllowed(a, `${boardOrigin('a')}/other.html`), false);
  assert.equal(boardNavigationAllowed('https://example.com/', a, card), false, 'a web page into a board');
  assert.equal(boardNavigationAllowed('https://example.com/', 'https://example.org/'), true, 'not a board: not this rule');
});

/* ── the handler, against a real folder ─────────────────────────────────────────────────── */

function fixture(): { root: string; outside: string; cleanup(): void } {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'boards-test-')));
  const root = path.join(base, 'boards');
  fs.mkdirSync(path.join(root, 'status', 'img'), { recursive: true });
  fs.mkdirSync(path.join(root, 'other'), { recursive: true });
  fs.mkdirSync(path.join(root, 'no-index'), { recursive: true });
  fs.writeFileSync(path.join(root, 'status', 'index.html'), '<p>ok</p>');
  fs.writeFileSync(path.join(root, 'status', 'img', 'a.png'), 'png');
  fs.writeFileSync(path.join(root, 'status', 'run.js'), 'alert(1)');
  fs.writeFileSync(path.join(root, 'status', 'board.json'), '{"title":"Status"}');
  fs.writeFileSync(path.join(root, 'other', 'index.html'), '<p>other</p>');
  const outside = path.join(base, 'secret.css');
  fs.writeFileSync(outside, 'secret');
  try { fs.symlinkSync(outside, path.join(root, 'status', 'link.css')); } catch { /* covered by the e2e where symlinks exist */ }
  fs.writeFileSync(path.join(root, 'status', '.secret.json'), '{"k":"v"}');
  try { fs.symlinkSync('.secret.json', path.join(root, 'status', 'pic.png')); } catch { /* as above */ }
  return { root, outside, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

async function get(url: string, method = 'GET'): Promise<{ status: number; csp: string | null; body: string; served: string[] }> {
  const served: string[] = [];
  const res = await serveBoardRequest(new Request(url, { method }), (f) => served.push(f));
  return { status: res.status, csp: res.headers.get('content-security-policy'), body: res.status === 200 ? await res.text() : '', served };
}

test('the handler serves a board\'s own files with its CSP, and refuses everything else', async () => {
  const fx = fixture();
  const prev = process.env.AIOS_BOARDS_DIR;
  process.env.AIOS_BOARDS_DIR = fx.root;
  try {
    const o = boardOrigin('status');
    const index = await get(`${o}/index.html?v=1`);
    assert.equal(index.status, 200);
    assert.equal(index.body, '<p>ok</p>');
    assert.equal(index.csp, boardCsp('status'), 'every response carries the board\'s own policy');
    assert.equal((await get(`${o}/img/a.png`)).status, 200);
    assert.equal((await get(`${o}/run.js`)).status, 403, 'a script inside the folder is still not served');
    assert.equal((await get(`${o}/board.json`)).status, 403, 'nor is the config');
    const link = await get(`${o}/link.css`);
    assert.ok(link.status === 403 || link.status === 404, `a symlink out of the folder is refused (${link.status})`);
    assert.deepEqual(link.served, [], 'and nothing was read');
    const inner = await get(`${o}/pic.png`);
    assert.equal(inner.status, 403, 'a symlink to a dot-file INSIDE the folder is still a dot-file, and not an asset type');
    assert.deepEqual(inner.served, []);
    assert.equal((await get(`${o}/index.html`, 'POST')).status, 405);
    assert.equal((await get(`${boardOrigin('no-index')}/index.html`)).status, 404);
    assert.equal((await get('aios-board://0123456789abcdef0123456789abcdef/index.html')).status, 404, 'an unknown board');
    const other = await get(`${boardOrigin('other')}/index.html`);
    assert.equal(other.csp, boardCsp('other'), 'the other board is its own origin with its own policy');
    assert.deepEqual(listBoards(NOW).map((r) => [r.name, r.title]), [['other', 'other'], ['status', 'Status']]);
  } finally {
    if (prev === undefined) delete process.env.AIOS_BOARDS_DIR; else process.env.AIOS_BOARDS_DIR = prev;
    fx.cleanup();
  }
});

test('no boards folder → no boards, no error', () => {
  const prev = process.env.AIOS_BOARDS_DIR;
  process.env.AIOS_BOARDS_DIR = path.join(os.tmpdir(), 'boards-test-does-not-exist-' + process.pid);
  try { assert.deepEqual(listBoards(NOW), []); } finally {
    if (prev === undefined) delete process.env.AIOS_BOARDS_DIR; else process.env.AIOS_BOARDS_DIR = prev;
  }
});

/* ── the card's frame (renderer/app.js reads as source; the e2e and the smoke run it) ───── */

test('the card\'s frame is fully sandboxed and never the HTML viewer\'s', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'app.js'), 'utf8');
  const start = app.indexOf('async function refreshBoards()');
  assert.ok(start > 0, 'refreshBoards exists');
  const body = app.slice(start, app.indexOf('\n}\n', start));
  assert.match(body, /setAttribute\('sandbox', ''\)/, 'sandbox="" — no tokens at all');
  assert.ok(!/allow-scripts|allow-same-origin|allow-top-navigation|allow-popups|allow-forms/.test(body), 'no sandbox token is granted');
  assert.match(body, /b\.frame\.src = r\.url/, 'the frame loads the URL main built (aios-board:), never a file:// path');
  assert.ok(!/fileUrl\(/.test(body), 'never file://');
});

test('the sample board in docs is a valid board: static, self-contained, served by the handler', async () => {
  const sample = path.join(__dirname, '..', '..', 'docs', 'rfcs', 'sidebar-boards-sample', 'index.html');
  const html = fs.readFileSync(sample, 'utf8');
  assert.ok(!/<script|\bon[a-z]+=|https?:|file:|\bsrc=|\bhref=/i.test(html), 'no scripts, handlers, links or external resources');
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'boards-sample-')));
  fs.mkdirSync(path.join(base, 'status'));
  fs.copyFileSync(sample, path.join(base, 'status', 'index.html'));
  const prev = process.env.AIOS_BOARDS_DIR;
  process.env.AIOS_BOARDS_DIR = base;
  try {
    const res = await serveBoardRequest(new Request(`${boardOrigin('status')}/index.html`));
    assert.equal(res.status, 200);
    assert.equal(await res.text(), html);
  } finally {
    if (prev === undefined) delete process.env.AIOS_BOARDS_DIR; else process.env.AIOS_BOARDS_DIR = prev;
    fs.rmSync(base, { recursive: true, force: true });
  }
});

/* #146: board.json can pick the card's icon. A name passes through; anything else is ignored without an error line. */
test('board.json icon: a plain name passes, a path, URL, markup or wrong type is ignored and is never an error', () => {
  assert.equal(parseBoardJson('{"icon": "chart"}').icon, 'chart');
  assert.equal(parseBoardJson('{"icon": " folderOpen "}').icon, 'folderOpen');
  for (const bad of ['"../x.svg"', '"https://e.com/i.png"', '"<svg onload=x>"', '3', 'null', '""', '"a-b"']) {
    const r = parseBoardJson(`{"icon": ${bad}}`);
    assert.equal(r.icon, undefined, bad);
    assert.equal(r.error, undefined, `${bad}: no error line for an icon`);
  }
  const rows = boardRows([{ name: 'gh', indexMtimeMs: 1, boardJson: '{"icon":"chart"}' }, { name: 'plain', indexMtimeMs: 1 }], 2);
  assert.equal(rows[0].icon, 'chart');
  assert.equal('icon' in rows[1], false, 'control: no board.json, no icon key');
});

test('board icon in the panel: a known name draws it, an unknown or missing one draws the board glyph', () => {
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  const fn = (name: string) => { const i = app.indexOf('function ' + name + '('); return app.slice(i, app.indexOf('\n}', i) + 2).replace(/\n\}$/, '\n}\n'); };
  const one = app.slice(app.indexOf('function boardIconName('), app.indexOf('\n', app.indexOf('function boardIconName(')) + 1);
  const make = (icons: object, cards: Map<string, { icon?: string }>) =>
    new Function('ICONS', 'CARD_ICONS', 'boardCards', one + fn('cardIcon') + 'return cardIcon;')(icons, {}, cards) as (k: string) => string;
  const ICONS = { chart: '<path/>', layout: '<path/>', star: '<path/>' };
  const cards = new Map([['gh status', { icon: 'chart' }], ['odd', { icon: 'nosuchicon' }], ['none', {}]]);
  const cardIcon = make(ICONS, cards);
  assert.equal(cardIcon('pBoard-' + encodeURIComponent('gh status')), 'chart');
  assert.equal(cardIcon('pBoard-odd'), 'layout', 'unknown name');
  assert.equal(cardIcon('pBoard-none'), 'layout', 'no icon');
  assert.equal(cardIcon('pBoard-' + encodeURIComponent('constructor')), 'layout', 'not in the map');
  const proto = make(ICONS, new Map([['p', { icon: 'toString' }]]));
  assert.equal(proto('pBoard-p'), 'layout', 'control: an inherited property is not an icon');
  assert.match(app, /JSON\.stringify\(\[r\.title, r\.status, r\.mtimeMs, r\.configError \|\| '', r\.icon \|\| '',/, 'a changed icon redraws the card');
});
