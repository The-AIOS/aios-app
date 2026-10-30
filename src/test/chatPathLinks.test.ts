/**
 * Paths in the chat view become links — the part that can be run for real.
 *
 * Two halves:
 *   1. the RESOLVER shared by the terminal and the chat (src/main/pathResolve.ts), run against a
 *      folder this test creates under the OS temp dir. Nothing here names a real person's path.
 *   2. the chat's linking (renderer/app.js), lifted out of the real source and run against a fake
 *      resolver and a small fake DOM, plus source guards — each with a negative control, because a
 *      guard that cannot fail reports confidence about something it never examined.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cleanCandidate, resolveOne, resolveMany, RESOLVE_FILES_LIMIT, RESOLVE_PATHS_LIMIT, type ResolveEnv } from '../main/pathResolve';

const read = (p: string): string => fs.readFileSync(p, 'utf8');

// ── 1 · the resolver ───────────────────────────────────────────────────────────────────────────

/** A throwaway tree: <tmp>/work (the base), <tmp>/work/notes/a b.md, <tmp>/work/src/main.ts, <tmp>/work/my folder/, <tmp>/home, and a file OUTSIDE every root. */
function tree(): { root: string; work: string; home: string; outside: string; env: ResolveEnv } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aios-chatpaths-')));
  const work = path.join(root, 'work');
  const home = path.join(root, 'home');
  const outside = path.join(root, 'elsewhere');
  fs.mkdirSync(path.join(work, 'notes'), { recursive: true });
  fs.mkdirSync(path.join(work, 'src'), { recursive: true });
  fs.mkdirSync(path.join(work, 'my folder'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(work, 'notes', 'a b.md'), 'x');
  fs.writeFileSync(path.join(work, 'src', 'main.ts'), 'x');
  fs.writeFileSync(path.join(home, 'todo.txt'), 'x');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'x');
  // the allowed roots are `work` and `home`, textually — the way main's inAllowed compares them
  const allowed = (abs: string): boolean => [work, home].some((r) => abs === r || abs.startsWith(r + path.sep));
  return { root, work, home, outside, env: { allowed, frameworkRoot: () => undefined, home } };
}

test('the resolver: a file that exists resolves, with its type', () => {
  const t = tree();
  assert.deepEqual(resolveOne('src/main.ts', t.work, t.env, true), { abs: path.join(t.work, 'src', 'main.ts'), dir: false });
  assert.deepEqual(resolveOne(path.join(t.work, 'src', 'main.ts'), undefined, t.env, true), { abs: path.join(t.work, 'src', 'main.ts'), dir: false });
});

test('the resolver: a folder resolves as a folder, and only when folders are asked for', () => {
  const t = tree();
  assert.deepEqual(resolveOne('notes', t.work, t.env, true), { abs: path.join(t.work, 'notes'), dir: true });
  assert.equal(resolveOne('notes', t.work, t.env, false), null, 'the terminal never asked for folders and must not start getting them');
});

test('the resolver: names with spaces, a ~ prefix and a :line suffix resolve', () => {
  const t = tree();
  assert.equal(resolveOne('notes/a b.md', t.work, t.env, true)?.abs, path.join(t.work, 'notes', 'a b.md'));
  assert.equal(resolveOne('my folder', t.work, t.env, true)?.dir, true);
  assert.equal(resolveOne('~/todo.txt', t.work, t.env, true)?.abs, path.join(t.home, 'todo.txt'));
  assert.equal(resolveOne('src/main.ts:42:7', t.work, t.env, true)?.abs, path.join(t.work, 'src', 'main.ts'));
  assert.equal(resolveOne('(see src/main.ts).', t.work, t.env, true), null, 'only TRAILING punctuation is trimmed, a leading paren is part of the string');
  assert.equal(resolveOne('src/main.ts).', t.work, t.env, true)?.abs, path.join(t.work, 'src', 'main.ts'));
});

test('the resolver: a path that does not exist does NOT resolve (negative control)', () => {
  const t = tree();
  assert.equal(resolveOne('src/nope.ts', t.work, t.env, true), null);
  assert.equal(resolveOne('nowhere', t.work, t.env, true), null);
  assert.equal(resolveOne('', t.work, t.env, true), null);
  assert.equal(resolveOne(undefined, t.work, t.env, true), null);
});

test('the resolver: a path outside the allowed roots does not resolve, however it is spelled', () => {
  const t = tree();
  const out = path.join(t.outside, 'secret.txt');
  assert.equal(fs.existsSync(out), true, 'control: the file is really there');
  assert.equal(resolveOne(out, t.work, t.env, true), null);
  /* `..` passes a textual startsWith check while naming a place outside the root: the reason the
     resolver normalises exactly those strings. */
  assert.equal(resolveOne(path.join(t.work, '..', 'elsewhere', 'secret.txt'), t.work, t.env, true), null);
  assert.equal(resolveOne('../elsewhere/secret.txt', t.work, t.env, true), null);
  // and the normalisation is not a blanket ban: a `..` that stays inside is still fine
  assert.equal(resolveOne(path.join(t.work, 'notes', '..', 'src', 'main.ts'), undefined, t.env, true)?.abs, path.join(t.work, 'src', 'main.ts'));
});

test('the resolver: the base folder wins, then the home folder is tried', () => {
  const t = tree();
  fs.writeFileSync(path.join(t.work, 'todo.txt'), 'x');
  assert.equal(resolveOne('todo.txt', t.work, t.env, true)?.abs, path.join(t.work, 'todo.txt'));
  fs.rmSync(path.join(t.work, 'todo.txt'));
  assert.equal(resolveOne('todo.txt', t.work, t.env, true)?.abs, path.join(t.home, 'todo.txt'), 'home is the last base');
});

test('resolveMany: keyed by the candidate as given, only what exists, and capped', () => {
  const t = tree();
  const got = resolveMany(['src/main.ts', 'notes', 'src/nope.ts'], t.work, t.env, { dirs: true, limit: RESOLVE_PATHS_LIMIT });
  assert.deepEqual(Object.keys(got).sort(), ['notes', 'src/main.ts']);
  assert.equal(got['notes'].dir, true);
  const filesOnly = resolveMany(['src/main.ts', 'notes'], t.work, t.env, { dirs: false, limit: RESOLVE_FILES_LIMIT });
  assert.deepEqual(Object.keys(filesOnly), ['src/main.ts'], 'files only means a folder is simply absent');
  const names = Array.from({ length: 30 }, (_, i) => `f${i}.txt`);
  for (const n of names) fs.writeFileSync(path.join(t.work, n), 'x');
  assert.equal(Object.keys(resolveMany(names, t.work, t.env, { dirs: false, limit: RESOLVE_FILES_LIMIT })).length, RESOLVE_FILES_LIMIT, 'a terminal line asks about at most 24');
  assert.equal(Object.keys(resolveMany(names, t.work, t.env, { dirs: true, limit: RESOLVE_PATHS_LIMIT })).length, 30, 'a chat message gets the higher ceiling');
  assert.deepEqual(resolveMany('not an array', t.work, t.env, { dirs: true, limit: 5 }), {});
});

test('cleanCandidate: the trimming rules are the terminal\'s, unchanged', () => {
  assert.equal(cleanCandidate('  src/a.ts:12:3). ', '/h'), 'src/a.ts');
  assert.equal(cleanCandidate('~/x/y.md', '/h'), path.join('/h', '/x/y.md'));
  assert.equal(cleanCandidate('', '/h'), '');
});

// ── the IPC handlers stay thin, and the terminal's one is still files-only ─────────────────────

const main = read('src/main/main.ts');
const preload = read('src/preload/preload.ts');
/** Run a check against the real source (must hold) and against a broken copy (must fail). */
function guarded(name: string, src: string, check: (s: string) => boolean, breakIt: (s: string) => string): void {
  test(name, () => {
    assert.ok(check(src), `${name}: the check does not hold on the real source`);
    const broken = breakIt(src);
    assert.notEqual(broken, src, `${name}: the negative control did not change anything`);
    assert.equal(check(broken), false, `${name}: the check still passes on a deliberately broken copy — it proves nothing`);
  });
}

guarded('fs:resolveFiles (the terminal\'s) stays on pathLinks and keeps its {open, reveal} reply: no chat-style folders in it', main,
  (s) => {
    const h = /ipcMain\.handle\('fs:resolveFiles'[\s\S]*?stat: statOrNull,\n  \}\)\);/.exec(s)?.[0] ?? '';
    return h.length > 60 && /resolveLinkTargets\(cands/.test(h) && !/dirs: true/.test(h) && !/resolveMany/.test(h);
  },
  (s) => s.replace("ipcMain.handle('fs:resolveFiles', (_e, cands: string[], base?: string) =>\n  resolveLinkTargets(cands, {", "ipcMain.handle('fs:resolveFiles', (_e, cands: string[], base?: string) =>\n  resolveMany(cands, base, resolveEnv, { dirs: true, limit: RESOLVE_PATHS_LIMIT }) || resolveLinkTargets(cands, {"));

guarded('the rules live in ONE place: no handler carries its own copy of the trimming, ~ or base logic', main,
  (s) => !/replace\(\/\[\)\\\]\},\.;:/.test(s) && !/os\.homedir\(\), v\.slice\(1\)/.test(s) && /resolveOne\(cand, base, resolveEnv, false\)/.test(s)
    && /resolveMany\(cands, base, resolveEnv, \{ dirs: true/.test(s) && /normalizeCandidate/.test(read('src/main/pathResolve.ts')),
  (s) => s.replace("resolveOne(cand, base, resolveEnv, false)?.abs ?? null", "String(cand).trim().replace(/[)\\]},.;:'\"]+$/, '')"));

guarded('the new channel is exposed by the preload and answers {abs, dir}', preload,
  (s) => /resolvePaths: \(cands: string\[\], base\?: string\): Promise<Record<string, \{ abs: string; dir: boolean \}>> => ipcRenderer\.invoke\('fs:resolvePaths', cands, base\)/.test(s) && /resolveFiles: \(cands: string\[\], base\?: string\): Promise<\{ open: Record<string, string>; reveal: Record<string, string> \}>/.test(s),
  (s) => s.replace("ipcRenderer.invoke('fs:resolvePaths', cands, base)", "ipcRenderer.invoke('fs:resolveFiles', cands, base)"));


// ── 2 · the chat's linking, run for real ───────────────────────────────────────────────────────

const app = read('renderer/app.js');
const START = '/* ═══ CHAT SKIN';
const END = '/* ═══ END CHAT SKIN ═══ */';
const skin = app.slice(app.indexOf(START), app.indexOf(END));
const BLOCK_FROM = '/* ── paths in the conversation become links';
const BLOCK_TO = '/* ── preferences: font + size';

/** A top-level function by name: from its header to the first closing brace at column 0. */
function fnBody(src: string, name: string): string {
  return new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`).exec(src)?.[0] ?? '';
}

/** Just enough DOM for the linker: children, text nodes, classes, attributes, listeners, replaceWith, connectedness. */
class FNode {
  nodeType = 1;
  nodeValue: string | null = null;
  parentNode: FNode | null = null;
  childNodes: FNode[] = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, Array<(e: unknown) => void>> = {};
  classes = new Set<string>();
  isRoot = false;
  tabIndex = -1;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
  constructor(public tagName: string, cls = '') { cls.split(/\s+/).filter(Boolean).forEach((c) => this.classes.add(c)); }
  get classList() { return { contains: (c: string) => this.classes.has(c) }; }
  get className() { return [...this.classes].join(' '); }
  get isConnected(): boolean { let n: FNode = this; while (n.parentNode) n = n.parentNode; return n.isRoot; }
  setAttribute(k: string, v: string) { this.attrs[k] = String(v); }
  getAttribute(k: string) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(type: string, fn: (e: unknown) => void) { (this.listeners[type] ||= []).push(fn); }
  getBoundingClientRect() { return { left: 0, top: 0 }; }
  append(...kids: FNode[]) { for (const k of kids) { k.parentNode = this; this.childNodes.push(k); } return this; }
  replaceWith(...nodes: FNode[]) {
    const p = this.parentNode!;
    const i = p.childNodes.indexOf(this);
    p.childNodes.splice(i, 1, ...nodes);
    nodes.forEach((n) => { n.parentNode = p; });
    this.parentNode = null;
  }
  fire(type: string, ev: Record<string, unknown> = {}) {
    const e = { preventDefault() {}, stopPropagation() {}, clientX: 0, clientY: 0, ...ev };
    for (const fn of this.listeners[type] || []) fn(e);
  }
}
const txt = (s: string): FNode => { const n = new FNode('#text'); n.nodeType = 3; n.nodeValue = s; return n; };
const elt = (tag: string, cls: string, ...kids: Array<FNode | string>): FNode => new FNode(tag, cls).append(...kids.map((k) => (typeof k === 'string' ? txt(k) : k)));
const all = (n: FNode): FNode[] => n.childNodes.flatMap((c) => [c, ...all(c)]);
const links = (n: FNode): FNode[] => all(n).filter((c) => c.classes.has('cs-path'));
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

interface Rig {
  link: (root: FNode, opts?: Record<string, unknown>) => void;
  asked: string[][];
  opened: string[];
  revealed: string[];
  shown: string[];
  cs: Record<string, unknown>;
  exists: Map<string, { abs: string; dir: boolean }>;
  gate: { hold: Promise<void> | null };
}
/** The real linking code from renderer/app.js, wired to a fake resolver (`exists`) and the fake DOM. */
function rig(src: string = app): Rig {
  const from = src.indexOf(BLOCK_FROM);
  const to = src.indexOf(BLOCK_TO);
  assert.ok(from > 0 && to > from, 'the path-link block was found in renderer/app.js');
  const grab = (re: RegExp, what: string): string => { const m = re.exec(src); assert.ok(m, `could not find ${what} in renderer/app.js`); return m![0]; };
  const code = [
    grab(/^const PATH_QUOTED_RE = .*$/m, 'PATH_QUOTED_RE'),
    grab(/^const PATH_RE = .*$/m, 'PATH_RE'),
    grab(/^function pathCandidates\(text\) \{[\s\S]*?\n\}/m, 'pathCandidates'),
    src.slice(from, to),
    'return { chatLinkPaths };',
  ].join('\n');
  const asked: string[][] = [];
  const opened: string[] = [];
  const revealed: string[] = [];
  const shown: string[] = [];
  const exists = new Map<string, { abs: string; dir: boolean }>();
  const gate: { hold: Promise<void> | null } = { hold: null };
  const win = {
    glassShell: {
      resolvePaths: async (cands: string[]) => {
        asked.push(cands);
        if (gate.hold) await gate.hold;
        const out: Record<string, { abs: string; dir: boolean }> = {};
        for (const c of cands) { const v = exists.get(c.replace(/[)\]},.;:'"]+$/, '')); if (v) out[c] = v; }   // main trims the prose punctuation before it looks
        return out;
      },
      revealInOS: async (p: string) => { revealed.push(p); return true; },
    },
    getSelection: () => ({ isCollapsed: true, toString: () => '' }),
  };
  const tr = (k: string, v?: Record<string, unknown>): string => `${k}${v ? JSON.stringify(v) : ''}`;
  const make = new Function('window', 'document', 'el', 't', 'linkBase', 'IS_WIN', 'showPathTip', 'hidePathTip', 'revealPath', 'openViewer', 'Date', code) as (...a: unknown[]) => { chatLinkPaths: Rig['link'] };
  const fns = make(win, { createTextNode: txt },
    (tag: string, cls?: string, text?: string) => elt(tag, cls || '', ...(text ? [text] : [])), tr,
    async (_id: unknown, cwd: string) => cwd, false, (_x: number, _y: number, s: string) => { shown.push(s); }, () => undefined,
    (abs: string) => { revealed.push('explorer:' + abs); }, (abs: string) => { opened.push(abs); }, Date);
  const cs = { id: 1, pane: { cwd: '/w' } };
  return { link: (root, opts) => (fns.chatLinkPaths as unknown as (r: FNode, c: unknown, o?: unknown) => void)(root, cs, opts), asked, opened, revealed, shown, cs, exists, gate };
}
const W = '/tmp/aios-fixture/work';

function fixture(r: Rig): void {
  r.exists.set('src/main.ts', { abs: `${W}/src/main.ts`, dir: false });
  r.exists.set('notes/a b.md', { abs: `${W}/notes/a b.md`, dir: false });
  r.exists.set('~/Desktop', { abs: '/tmp/aios-fixture/home/Desktop', dir: true });
  r.exists.set('dist/', { abs: `${W}/dist`, dir: true });
}

test('chat links: what exists becomes a link, what does not stays text (and both are asked in ONE batch)', async () => {
  const r = rig(); fixture(r);
  const p = elt('p', '', 'I changed src/main.ts and src/gone.ts, then ran it from dist/ and left it in ~/Desktop.');
  const root = elt('div', 'chat-md', p);
  root.isRoot = true;
  r.link(root);
  assert.equal(links(root).length, 0, 'the text is on screen first: nothing is a link until the answer comes');
  await tick();
  const got = links(root);
  assert.deepEqual(got.map((l) => l.childNodes[0].nodeValue), ['src/main.ts', 'dist/', '~/Desktop'], 'the existing ones, in order; src/gone.ts is not among them');
  assert.deepEqual(got.map((l) => l.csPath), [{ abs: `${W}/src/main.ts`, dir: false }, { abs: `${W}/dist`, dir: true }, { abs: '/tmp/aios-fixture/home/Desktop', dir: true }]);
  assert.equal(r.asked.length, 1, 'one batch for the whole message');
  const flat = p.childNodes.map((n) => (n.classes.has('cs-path') ? n.childNodes[0].nodeValue : n.nodeValue)).join('');
  assert.equal(flat, 'I changed src/main.ts and src/gone.ts, then ran it from dist/ and left it in ~/Desktop.', 'not one character of the message changed');
  assert.ok(!got.some((l) => /[.,]$/.test(String(l.childNodes[0].nodeValue))), 'the full stop that ends a sentence is not part of the link');
});

test('NEGATIVE CONTROL: with nothing existing, nothing is a link', async () => {
  const r = rig();   // empty `exists`
  const root = elt('div', 'chat-md', elt('p', '', 'see src/main.ts and ~/Desktop and dist/'));
  root.isRoot = true;
  r.link(root);
  await tick();
  assert.ok(r.asked.length > 0, 'control: it did ask');
  assert.equal(links(root).length, 0);
});

test('chat links: a name with spaces links whole, not as the folder prefix that also exists', async () => {
  const r = rig(); fixture(r);
  r.exists.set('notes/a', { abs: `${W}/notes/a`, dir: true });   // a decoy: the shorter prefix exists too
  const root = elt('div', 'chat-md', elt('p', '', 'it is in ', elt('code', '', 'notes/a b.md'), ' now'));
  root.isRoot = true;
  r.link(root);
  await tick();
  const got = links(root);
  assert.equal(got.length, 1);
  assert.equal(got[0].childNodes[0].nodeValue, 'notes/a b.md');
  assert.equal(got[0].csPath.dir, false, 'the longest candidate that exists wins');
});

test('chat links: code blocks are linked inside their highlight spans, and the text around is untouched', async () => {
  const r = rig(); fixture(r);
  const span = elt('span', 'hljs-string', '"src/main.ts"');
  const code = elt('code', 'hljs language-bash', 'cat ', span, ' | head');
  const root = elt('div', 'chat-md', elt('div', 'cm-code', elt('div', 'cm-code-head', elt('span', 'cm-lang', 'src/main.ts'), elt('button', 'cm-copy', 'src/main.ts')), elt('pre', '', code)));
  root.isRoot = true;
  r.link(root);
  await tick();
  const got = links(root);
  assert.equal(got.length, 1, 'only the one in the code, not the header or the button');
  assert.equal(got[0].parentNode, span, 'the highlight span stays; only its text node was split');
  assert.equal(code.childNodes[0].nodeValue, 'cat ');
  assert.equal(code.childNodes[2].nodeValue, ' | head');
});

test('chat links: an existing link and a button are skipped — nothing nested inside them', async () => {
  const r = rig(); fixture(r);
  const root = elt('div', 'chat-md', elt('p', '', elt('A', '', 'src/main.ts'), ' ', elt('BUTTON', '', 'src/main.ts')));
  root.isRoot = true;
  r.link(root);
  await tick();
  assert.equal(r.asked.length, 0, 'there was nothing to ask about');
  assert.equal(links(root).length, 0);
});

test('chat links: the operator\'s bubble links too, and a tool row\'s argument (whole text for a Read) with mouse-only links', async () => {
  const r = rig(); fixture(r);
  const bubble = elt('div', 'chat-bubble', 'please open src/main.ts');
  bubble.isRoot = true;
  r.link(bubble);
  const arg = elt('span', 'ct-arg', `${W}/src/main.ts`);
  arg.isRoot = true;
  r.exists.set(`${W}/src/main.ts`, { abs: `${W}/src/main.ts`, dir: false });
  r.link(arg, { inButton: true, whole: true });
  await tick();
  assert.equal(links(bubble).length, 1);
  assert.equal(links(arg).length, 1);
  assert.equal(links(arg)[0].attrs.role, undefined, 'inside a button it is not a second tab stop');
  assert.equal(links(bubble)[0].attrs.role, 'link');
  assert.equal(links(bubble)[0].tabIndex, 0, 'elsewhere it is reachable with the keyboard');
});

test('chat links: a click opens a file in the viewer and reveals a folder in the explorer; ⌘⇧ hands it to the desktop; Enter works', async () => {
  const r = rig(); fixture(r);
  const root = elt('div', 'chat-md', elt('p', '', 'a src/main.ts b dist/ c'));
  root.isRoot = true;
  r.link(root);
  await tick();
  const [file, dir] = links(root);
  file.fire('click', {});
  assert.deepEqual(r.opened, [`${W}/src/main.ts`], 'a plain click on a file = ⌘-click in the terminal');
  dir.fire('click', {});
  assert.deepEqual(r.revealed, [`explorer:${W}/dist`], 'a folder is revealed in the explorer');
  file.fire('click', { metaKey: true, shiftKey: true });
  dir.fire('click', { ctrlKey: true, shiftKey: true });
  assert.deepEqual(r.revealed.slice(1), [`${W}/src/main.ts`, `${W}/dist`], '⌘/Ctrl+Shift goes to the desktop');
  assert.equal(r.opened.length, 1, 'and does not also open it');
  file.fire('keydown', { key: 'Enter' });
  assert.equal(r.opened.length, 2);
  file.fire('keydown', { key: 'a' });
  assert.equal(r.opened.length, 2, 'only Enter');
  file.fire('mouseenter', { clientX: 5, clientY: 5 });
  assert.match(r.shown[0], new RegExp(`^${W}/src/main.ts  ·  chat\\.path\\.openFile  ·  term\\.cmdShiftClickReveal$`), 'the tooltip has the absolute path and the gesture');
});

test('chat links: a message re-rendered while the answer is on its way is left alone', async () => {
  const r = rig(); fixture(r);
  let release: () => void = () => undefined;
  r.gate.hold = new Promise<void>((res) => { release = res; });
  const p = elt('p', '', 'open src/main.ts');
  const root = elt('div', 'chat-md', p);
  root.isRoot = true;
  const old = p.childNodes[0];
  r.link(root);
  await tick();
  // chatRender replaces the children: the node the pass captured is gone, the new one carries the same words
  root.childNodes.length = 0;
  p.parentNode = null;
  void old;
  const p2 = elt('p', '', 'open src/main.ts');
  root.append(p2);
  release();
  await tick(); await tick();
  assert.equal(links(root).length, 0, 'the stale pass must not touch the new render');
  // and an edited text node is skipped too
  const p3 = elt('p', '', 'open notes/a b.md');   // a string the first pass did not cache, so this one really waits for the answer
  const root3 = elt('div', 'chat-md', p3);
  root3.isRoot = true;
  r.gate.hold = new Promise<void>((res) => { release = res; });
  r.link(root3);
  await tick();
  p3.childNodes[0].nodeValue = 'something else entirely';
  release();
  await tick(); await tick();
  assert.equal(links(root3).length, 0);
});

test('chat links: what was asked once is not asked again (the cache), and a newer pass over the same node wins', async () => {
  const r = rig(); fixture(r);
  const mk = (): FNode => { const x = elt('div', 'chat-md', elt('p', '', 'open src/main.ts')); x.isRoot = true; return x; };
  const a = mk(); r.link(a); await tick();
  const b = mk(); r.link(b); await tick(); await tick();
  assert.equal(r.asked.length, 1, 'the second message hits the cache');
  assert.equal(links(b).length, 1, 'and is still linked');
});

// ── security: the model's text can never produce a file: href or a link of its own ────────────

/** Everything the model could write that tries to be a link to a file, as TEXT (the sanitiser has already turned raw HTML into text). */
const HOSTILE = 'see file:///tmp/aios-fixture/work/src/main.ts and <a href="file:///tmp/aios-fixture/work/src/main.ts">src/main.ts</a> and [x](file:///etc/hosts)';
async function linkHostile(src: string): Promise<FNode> {
  const r = rig(src); fixture(r);
  r.exists.set('/tmp/aios-fixture/work/src/main.ts', { abs: `${W}/src/main.ts`, dir: false });
  const root = elt('div', 'chat-md', elt('p', '', HOSTILE));
  root.isRoot = true;
  r.link(root);
  await tick();
  return root;
}
const clean = (root: FNode): boolean => all(root).every((n) => n.nodeType === 3 || (n.tagName.toUpperCase() !== 'A' && !('href' in n.attrs) && !Object.values(n.attrs).some((v) => /^file:/i.test(v))));

test('security: model text with file:// and <a href="file:"> leaves no href and no anchor — only our own spans, with the target in a property', async () => {
  const root = await linkHostile(app);
  assert.ok(links(root).length >= 1, 'control: something was linked, so the check below looked at real output');
  assert.ok(clean(root), 'no <a>, no href, no file: attribute anywhere');
  assert.ok(links(root).every((l) => l.tagName.toUpperCase() === 'SPAN' && typeof l.csPath.abs === 'string'));
});

test('security NEGATIVE CONTROL: a linker that emitted an <a href> would be caught by the same check', async () => {
  const broken = app.replace("const a = el('span', 'cs-path '", "const a = el('a', 'cs-path '").replace('a.csPath = target;', "a.csPath = target; a.setAttribute('href', 'file://' + seg.abs);");
  assert.notEqual(broken, app);
  const root = await linkHostile(broken);
  assert.equal(clean(root), false, 'the check must fail on a linker that writes an href');
});

test('security: the sanitiser still admits only http(s) and mailto hrefs, so file: can never survive it', () => {
  const san = fnBody(skin, 'chatSanitize');
  const re = /\/\^\(https\?:\|mailto:\)\/i/.exec(san);
  assert.ok(re, 'the allowlist regex is still in chatSanitize');
  const allow = new RegExp('^(https?:|mailto:)', 'i');
  for (const bad of ['file:///etc/hosts', 'FILE:///etc/hosts', ' file:///x', 'javascript:alert(1)', 'data:text/html,x', 'x-file:///']) assert.equal(allow.test(bad), false, bad);
  for (const ok of ['https://a.test', 'http://a.test', 'mailto:a@b.test']) assert.equal(allow.test(ok), true, ok);
  const loosened = san.replace('https?:|mailto:', 'https?:|mailto:|file:');
  assert.notEqual(loosened, san);
  assert.match(loosened, /file:/, 'control: the loosened copy is distinguishable');
});

// ── source guards ─────────────────────────────────────────────────────────────────────────────

function guardedApp(name: string, check: (src: string) => boolean, breakIt: (src: string) => string): void {
  guarded(name, app, check, breakIt);
}

guardedApp('the linking runs AFTER chatSanitize and chatDecorate, and chatRender itself never links',
  (src) => {
    const s = src.slice(src.indexOf(START), src.indexOf(END));
    const render = fnBody(s, 'chatRender');
    const upsert = fnBody(s, 'chatSkinUpsert');
    return render.indexOf('chatSanitize(') > 0 && render.indexOf('chatSanitize(') < render.indexOf('chatDecorate(frag)')
      && !/chatLinkPaths/.test(render)
      && /chatRender\(rec\.body, text\); rec\.text = text; chatLinkPaths\(rec\.body, cs\)/.test(upsert);
  },
  (src) => src.replace('chatDecorate(frag);\n  target.replaceChildren(frag);', 'chatDecorate(frag);\n  chatLinkPaths(frag);\n  target.replaceChildren(frag);'));

guardedApp('the streaming preview is never linked: only the finished message is',
  (src) => {
    const s = src.slice(src.indexOf(START), src.indexOf(END));
    return !/chatLinkPaths/.test(fnBody(s, 'chatSkinStream')) && !/chatLinkPaths/.test(fnBody(s, 'chatSkinStreamAdopt')) && !/chatLinkPaths/.test(fnBody(s, 'chatSkinStreamDrop'))
      && /chatRender\(st\.rec\.body, chatSkinStreamMd\(text\)\);/.test(s);
  },
  (src) => src.replace('if (st.text !== text) { chatRender(st.rec.body, chatSkinStreamMd(text)); st.text = text; }', 'if (st.text !== text) { chatRender(st.rec.body, chatSkinStreamMd(text)); chatLinkPaths(st.rec.body, cs); st.text = text; }'));

guardedApp('candidates come from the terminal\'s pathCandidates: the chat defines no path regex of its own for what the terminal already finds',
  (src) => {
    const s = src.slice(src.indexOf(START), src.indexOf(END));
    return /const out = pathCandidates\(line\);/.test(fnBody(s, 'chatPathCandidates')) && !/const PATH_RE\b|const PATH_QUOTED_RE\b/.test(s) && (src.match(/^const PATH_RE = /gm) || []).length === 1;
  },
  (src) => src.replace('const out = pathCandidates(line);', 'const out = [];'));

guardedApp('the link is built here and opens only through the existing, validated functions',
  (src) => {
    const s = src.slice(src.indexOf(START), src.indexOf(END));
    const mk = fnBody(s, 'chatPathMakeLink');
    const open = fnBody(s, 'chatPathOpen');
    return !/innerHTML|createElement\('a'\)|el\('a'/.test(mk) && !/setAttribute\('href'/.test(mk) && /void openViewer\(target\.abs\)/.test(open)
      && /void revealPath\(target\.abs\)/.test(open) && /void window\.glassShell\.revealInOS\(target\.abs\)/.test(open) && !/file:/.test(mk + open);
  },
  (src) => src.replace('void openViewer(target.abs);', 'window.open("file://" + target.abs);'));

guardedApp('the resolution is asynchronous and batched: one call per message through the new channel, never the files-only one',
  (src) => {
    const s = src.slice(src.indexOf(START), src.indexOf(END));
    return /window\.glassShell\.resolvePaths\(chunk,/.test(fnBody(s, 'chatResolvePaths')) && !/resolveFiles|resolveFile\b/.test(s.slice(s.indexOf(BLOCK_FROM), s.indexOf(BLOCK_TO)))
      && /void \(async \(\) => \{/.test(fnBody(s, 'chatLinkPaths')) && /if \(!tg\.node\.isConnected \|\| tg\.node\.nodeValue !== tg\.text\) continue;/.test(fnBody(s, 'chatLinkPaths'));
  },
  (src) => src.replace('window.glassShell.resolvePaths(chunk,', 'window.glassShell.resolveFiles(chunk,'));

guardedApp('the terminal\'s own link provider is unchanged: it still asks for files only and still needs ⌘/Ctrl',
  (src) => /window\.glassShell\.resolveFiles\(hits\.flatMap/.test(src) && /if \(!ev\.metaKey && !ev\.ctrlKey\) return;/.test(src) && !/resolvePaths/.test(src.slice(src.indexOf('function attachPathLinks'), src.indexOf('/* ═══ TAB ORDER'))),
  (src) => src.replace('window.glassShell.resolveFiles(hits.flatMap', 'window.glassShell.resolvePaths(hits.flatMap'));

test('the new strings exist in all three languages', () => {
  for (const loc of ['en', 'es', 'pt-br']) {
    const j = JSON.parse(read(`src/i18n/locales/${loc}.json`)) as Record<string, string>;
    for (const k of ['chat.path.openFile', 'chat.path.openDir', 'chat.path.labelFile', 'chat.path.labelDir']) assert.ok(j[k] && j[k].length > 3, `${loc}: ${k}`);
    assert.match(j['chat.path.labelFile'], /\{path\}/);
    assert.match(j['chat.path.labelDir'], /\{path\}/);
  }
});

test('the link style uses tokens only and has a keyboard focus ring', () => {
  const css = read('renderer/theme.css');
  const rules = css.slice(css.indexOf('.cs-path {'), css.indexOf('@media (prefers-reduced-motion: reduce) { .cs-path'));
  assert.ok(rules.length > 200);
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(rules), false, 'no hex colours');
  assert.match(rules, /color: var\(--chat-link\)/);
  assert.match(rules, /\.cs-path:focus-visible/);
  assert.match(rules, /cursor: pointer/);
});
