/**
 * The `open` verb (contract 5), run against the framework's own conformance fixture (copied
 * verbatim, through cases.lock.json, from skills/aios/orchestration-ladder/inbox-contract-5.
 * conformance.json), then against a real directory of toy files for what a fixture cannot show:
 * links and hard links on a real disk, permission bits, that a secret is refused without being read,
 * that a link out of the root is never followed, and that `readChecked` shows only what was checked.
 *
 * No test here reads a real secret: every file is created in a temporary folder and removed.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  decideOpen, readChecked, prepareRoots, looksLikeFramework, isSecretPath, windowsShape, rememberDecided,
  OPEN_MAX_AGE_MS, OPEN_RATE_MAX, OPEN_FLOOD_MAX, OPEN_RATE_WINDOW_MS, OPEN_MAX_LINE, OPEN_MAX_NAME,
  type OpenFs, type OpenClass, type OpenStat,
} from '../src/openRequest';

type Entry = { kind: 'file'; class: OpenClass; executable?: boolean; links?: number; stored?: string } | { kind: 'dir' } | { kind: 'other' } | { kind: 'symlink'; to: string };
interface Fixture {
  contract: number;
  constants: Record<string, number>;
  home: string; roots: string[]; fs: Record<string, Entry>;
  cases: { case: string; request: Record<string, unknown>; age_ms: number; present_at_start?: boolean; recent?: { name: string; ago_ms: number }[]; expect: Record<string, unknown> }[];
  windows_paths: { case: string; path: string; why: string | null }[];
  windows_roots: { case: string; root: string; path: string; inside: boolean }[];
  framework_roots: { case: string; roots: string[]; usable: string[] }[];
}
const FIX = path.join(__dirname, '..', '..', 'cases', 'inbox-contract-5.conformance.json');
const fx = JSON.parse(fs.readFileSync(FIX, 'utf8')) as Fixture;

/** The fixture's file system. Every path the decision touches is recorded. */
function fixtureFs(e: Record<string, Entry>): OpenFs & { touched: string[] } {
  const touched: string[] = [];
  const inodes = new Map<string, number>();
  const stat = (p: string): OpenStat | null => {
    const n = e[p];
    if (!inodes.has(p)) inodes.set(p, inodes.size + 1);
    const id = { dev: 1, ino: inodes.get(p) as number };
    if (n) {
      if (n.kind === 'file') return { kind: 'file', links: n.links ?? 1, executable: !!n.executable, ...id };
      if (n.kind === 'symlink') return { kind: 'symlink', links: 1, executable: false, ...id };
      return { kind: n.kind, links: 1, executable: false, ...id };
    }
    if (Object.keys(e).some((k) => k.startsWith(p.replace(/\/$/, '') + '/'))) return { kind: 'dir', links: 1, executable: false, ...id };
    return null;
  };
  const self: OpenFs & { touched: string[] } = {
    touched,
    lstat(p) { touched.push(p); return stat(p); },
    readlink(p) { touched.push(p); const n = e[p]; return n && n.kind === 'symlink' ? n.to : null; },
    realpath(p) {
      let queue = p.split('/').filter(Boolean); let out: string[] = []; let hops = 0;
      while (queue.length) {
        const c = queue.shift() as string;
        const cand = '/' + [...out, c].join('/');
        const n = stat(cand);
        if (!n) return null;
        const l = e[cand];
        if (l && l.kind === 'symlink') {
          if (++hops > 40) return null;
          const t = l.to.startsWith('/') ? l.to : path.posix.normalize(path.posix.join(path.posix.dirname(cand), l.to));
          queue = [...t.split('/').filter(Boolean), ...queue]; out = [];
          continue;
        }
        out.push(c);
      }
      const r = '/' + out.join('/'); const f = e[r];
      return f && f.kind === 'file' && typeof f.stored === 'string' ? (f.stored || null) : r;   // the name the disk stores, when the fixture gives one
    },
    classify(p) { const n = e[p]; return n && n.kind === 'file' ? n.class : 'binary'; },
  };
  return self;
}

test('the fixture is contract 5, and its numbers are this module\'s', () => {
  assert.equal(fx.contract, 5);
  assert.ok(fx.cases.length >= 100);
  assert.deepEqual(fx.constants, {
    max_age_ms: OPEN_MAX_AGE_MS, rate_max: OPEN_RATE_MAX, flood_max: OPEN_FLOOD_MAX,
    rate_window_ms: OPEN_RATE_WINDOW_MS, max_line: OPEN_MAX_LINE, max_name: OPEN_MAX_NAME,
  });
});

const NOW = 1_000_000_000_000;
const prepared = prepareRoots(fx.roots, fx.home, { fs: fixtureFs(fx.fs), platform: 'linux' });

test('prepared roots: exactly one is left, the framework root', () => {
  assert.deepEqual(prepared.map((r) => r.real), ['/home/op/aios']);
});
for (const f of fx.framework_roots) {
  test(`conformance (framework root): ${f.case}`, () => {
    assert.deepEqual(prepareRoots(f.roots, fx.home, { fs: fixtureFs(fx.fs), platform: 'linux' }).map((r) => r.real), f.usable);
  });
}

for (const c of fx.cases) {
  test(`conformance: ${c.case}`, () => {
    const decided = (c.recent ?? []).map((r) => ({ name: r.name, at: NOW - r.ago_ms }));
    const d = decideOpen({ body: c.request, seenAgoMs: c.age_ms, presentAtStart: !!c.present_at_start, nowMs: NOW, roots: prepared, decided, fs: fixtureFs(fx.fs), platform: 'linux' });
    if (c.expect.do === 'refuse') {
      assert.equal(d.do, 'refuse', `expected a refusal (${String(c.expect.why)}), got ${JSON.stringify(d)}`);
      assert.equal(d.do === 'refuse' && d.why, c.expect.why);
      assert.ok(d.do === 'refuse' && d.reason.length > 0, 'a refusal says why, for the dead letter');
    } else {
      assert.equal(d.do, 'open', `expected an open, got ${JSON.stringify(d)}`);
      const got: Record<string, unknown> = { do: 'open', path: d.do === 'open' && d.path, mode: d.do === 'open' && d.mode };
      if (d.do === 'open' && d.line !== undefined) got.line = d.line;
      assert.deepEqual(got, c.expect);
    }
  });
}

test('checks 1 to 8 touch no file system for a path outside the root, a secret, a bad shape or a bad request', () => {
  for (const p of ['/home/op/notes/out.md', '/etc/passwd', '/home/op/aios/vault/.env', 'relative.md', '/home/op/aios/vault/../../x']) {
    const ffs = fixtureFs(fx.fs);
    decideOpen({ body: { name: 'w1', path: p }, seenAgoMs: 0, nowMs: NOW, roots: prepared, decided: [], fs: ffs, platform: 'linux' });
    assert.deepEqual(ffs.touched, [], `${p} touched ${ffs.touched.join(', ')}`);
  }
});

test('a link out of the root is read, never followed: its target is never touched', () => {
  const ffs = fixtureFs(fx.fs);
  const d = decideOpen({ body: { name: 'w1', path: '/home/op/aios/vault/key-link.md' }, seenAgoMs: 0, nowMs: NOW, roots: prepared, decided: [], fs: ffs, platform: 'linux' });
  assert.equal(d.do === 'refuse' && d.why, 'unavailable');
  assert.ok(!ffs.touched.some((t) => t.includes('.ssh')), `touched: ${ffs.touched.join(', ')}`);
  assert.ok(d.do === 'refuse' && !d.reason.includes('.ssh'), 'the target never appears in the dead letter');
});

test('a too-old request is not counted; every other decision is', () => {
  const old = decideOpen({ body: { name: 'w1', path: '/x' }, seenAgoMs: OPEN_MAX_AGE_MS + 1, nowMs: NOW, roots: prepared, decided: [], fs: fixtureFs(fx.fs), platform: 'linux' });
  assert.equal(old.do === 'refuse' && old.counted, false);
  const bad = decideOpen({ body: { name: 'w1', path: 'x' }, seenAgoMs: 0, nowMs: NOW, roots: prepared, decided: [], fs: fixtureFs(fx.fs), platform: 'linux' });
  assert.equal(bad.do === 'refuse' && bad.counted, true);
});

for (const w of fx.windows_paths) {
  test(`conformance (windows path): ${w.case}`, () => {
    const p = w.path.replace(/^[ \t]+|[ \t]+$/g, '');
    assert.equal(windowsShape(p) ?? (isSecretPath(p) ? 'secret' : null), w.why);
  });
}
for (const w of fx.windows_roots) {
  test(`conformance (windows root): ${w.case}`, () => {
    /* Everything exists and is a plain file here: only the root comparison is under test. */
    const id: OpenFs = {
      lstat: (p) => ({ kind: /[\\/](vault|plugins[\\/]aios)$/i.test(p) ? 'dir' : 'file', links: 1, dev: 1, ino: 1, executable: false }),
      readlink: () => null, realpath: (p) => p, classify: () => 'text',
    };
    const roots = prepareRoots([w.root], 'C:\\Users\\op', { fs: id, platform: 'win32' });
    const d = decideOpen({ body: { name: 'w1', path: w.path }, seenAgoMs: 0, nowMs: NOW, roots, decided: [], fs: id, platform: 'win32' });
    assert.equal(d.do === 'refuse' && d.why === 'unavailable', !w.inside, JSON.stringify(d));
  });
}

/* ── the same decision on a real disk ─────────────────────────────────────────────────── */
const made: string[] = [];
after(() => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } } });
function disk(): { home: string; root: string; at: (rel: string, text?: string) => string } {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aios-open-')));
  made.push(base);
  const home = path.join(base, 'home'); const root = path.join(home, 'aios');
  for (const d of ['aios/vault', 'aios/plugins/aios', 'outside']) fs.mkdirSync(path.join(home, d), { recursive: true });
  return { home, root, at: (rel, text = 'x\n') => { const p = path.join(home, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; } };
}
const ask = (p: string, d: { home: string; root: string }, extra: Record<string, unknown> = {}) =>
  decideOpen({ body: { action: 'open', name: 'w1', path: p, ...extra }, seenAgoMs: 1000, nowMs: Date.now(), roots: prepareRoots([d.root], d.home), decided: [] });
const posix = process.platform !== 'win32';

test('real disk: a note inside the root opens, at its resolved path, with its identity', () => {
  const d = disk(); const p = d.at('aios/vault/note.md');
  const r = ask(p, d);
  assert.equal(r.do === 'open' && r.path, p);
  assert.ok(r.do === 'open' && r.identity.ino > 0);
  assert.equal(looksLikeFramework(d.root), true);
  assert.equal(looksLikeFramework(path.join(d.home, 'outside')), false);
});

test('real disk: a hard link to a file outside the root is refused', { skip: !posix && 'hard links need care on Windows' }, () => {
  const d = disk(); const target = d.at('outside/key.txt'); const link = path.join(d.root, 'vault', 'meeting.md');
  fs.linkSync(target, link);
  assert.equal((ask(link, d) as { why?: string }).why, 'hard-link');
});

test('real disk: a link inside the root that points outside is refused', { skip: !posix && 'symlinks need privileges on Windows' }, () => {
  const d = disk(); const target = d.at('outside/private.md'); const link = path.join(d.root, 'vault', 'innocent.md');
  fs.symlinkSync(target, link);
  const r = ask(link, d);
  assert.equal(r.do === 'refuse' && r.why, 'unavailable');
  assert.ok(r.do === 'refuse' && !r.reason.includes('outside'));
});

test('real disk: a relative link inside the root is followed', { skip: !posix && 'symlinks need privileges on Windows' }, () => {
  const d = disk(); const p = d.at('aios/vault/real/note.md');
  fs.symlinkSync('real', path.join(d.root, 'vault', 'alias'));
  assert.equal((ask(path.join(d.root, 'vault', 'alias', 'note.md'), d) as { path?: string }).path, p);
});

test('real disk: a link loop is unavailable, and does not hang', { skip: !posix && 'symlinks need privileges on Windows' }, () => {
  const d = disk(); const v = path.join(d.root, 'vault');
  fs.symlinkSync(path.join(v, 'b'), path.join(v, 'a'));
  fs.symlinkSync(path.join(v, 'a'), path.join(v, 'b'));
  assert.equal((ask(path.join(v, 'a'), d) as { why?: string }).why, 'unavailable');
});

test('real disk: a secret by name is refused WITHOUT being read', { skip: !posix && 'permission bits are POSIX' }, () => {
  const d = disk(); const p = d.at('aios/vault/.env', 'TOY=not-a-secret\n');
  fs.chmodSync(p, 0o000);
  try { assert.equal((ask(p, d) as { why?: string }).why, 'secret'); } finally { fs.chmodSync(p, 0o600); }
});

test('real disk: a script with the execute bit is refused; a note with it opens', { skip: !posix && 'permission bits are POSIX' }, () => {
  const d = disk(); const s = d.at('aios/vault/run.sh', '#!/bin/sh\necho hi\n'); const n = d.at('aios/vault/note.md');
  fs.chmodSync(s, 0o755); fs.chmodSync(n, 0o755);
  assert.equal((ask(s, d) as { why?: string }).why, 'executable');
  assert.equal(ask(n, d).do, 'open');
});

test('real disk: a binary is refused, never handed on', () => {
  const d = disk(); const p = d.at('aios/vault/blob.dat', 'a\u0000b');
  assert.equal((ask(p, d) as { why?: string }).why, 'unreadable');
});

test('real disk: a pipe is not a file, and deciding on it does not block', { skip: !posix && 'fifos are POSIX' }, () => {
  const d = disk(); const p = path.join(d.root, 'vault', 'pipe');
  require('node:child_process').execFileSync('mkfifo', [p]);
  assert.equal((ask(p, d) as { why?: string }).why, 'not-a-file');
});

test('real disk: roots listed as home, a hidden home folder, or an ancestor of home are dropped', () => {
  const d = disk(); fs.mkdirSync(path.join(d.home, '.config', 'gh'), { recursive: true });
  const r = prepareRoots([d.home, path.join(d.home, '.config'), path.dirname(d.home), '/', d.root], d.home);
  assert.deepEqual(r.map((x) => x.real), [d.root]);
});

test('readChecked shows the file that was checked, and refuses a swap made after the decision', { skip: !posix && 'symlinks need privileges on Windows' }, () => {
  const d = disk(); const p = d.at('aios/vault/note.md', 'the note\n'); const secret = d.at('aios/vault/sub/other.md', 'OTHER\n');
  const r = ask(p, d);
  assert.ok(r.do === 'open');
  if (r.do !== 'open') return;
  const roots = prepareRoots([d.root], d.home);
  assert.deepEqual(readChecked(p, r.identity, { roots }), { ok: true, path: p, content: 'the note\n' });
  fs.rmSync(p); fs.symlinkSync(secret, p);   // swapped for a link to another file inside the root
  assert.equal(readChecked(p, r.identity, { roots }).ok, false, 'a different file at the end of the walk');
  fs.rmSync(p); fs.symlinkSync(d.at('outside/private.md', 'PRIVATE\n'), p);   // or outside it
  const out = readChecked(p, r.identity, { roots });
  assert.equal(out.ok, false);
  assert.ok(!('content' in out));
});

test('the secret rule: what it refuses and what it leaves alone', () => {
  for (const s of ['C:\\Users\\op\\repo\\.ENV', '/v/.ssh/notes.md', '/v/agent-secrets/x.md', '/r/token.json', '/r/gcp-oauth-client.json',
    '/r/storage_state.json', '/r/.git/config', '/v/.obsidian/plugins/x/data.json', '/r/service-account-prod.json', '/r/db.kdbx', '/r/id_ecdsa',
    '/r/id_rsa_work', '/a/.claude/settings.local.json', '/a/mcps/playwright-mcp/auth/site.json', '/r/token-usage.json']) {
    assert.equal(isSecretPath(s), true, s);
  }
  for (const s of ['/r/.ßh/x.md', '/r/.ẞh/x.md', '/r/.gıt/config', '/v/.obſidian/plugins/x/data.json', '/r/accessTokens.json', '/r/oauth2.json',
    '/r/api-key.txt', '/r/api_keys.json', '/r/.env_prod', '/r/prod.env.local', '/r/token.json.bak', '/r/secrets.ini', '/r/private.asc']) {
    assert.equal(isSecretPath(s), true, s);
  }
  for (const s of ['/v/id_card.md', '/r/id_ed25519.pub', '/v/notes.md', '/v/tokenomics.md', '/v/secrets-of-sales.md', '/v/cookie-recipes.md',
    '/r/.github/ci.yml', '/r/known_hosts', '/r/tokenizer.json', '/v/auth/notes.md', '/v/.envelope.md', '/v/.environment-notes.md']) {
    assert.equal(isSecretPath(s), false, s);
  }
});

test('the remembered requests keep one minute and at most 200', () => {
  let r: { name: string; at: number }[] = [];
  for (let i = 0; i < 300; i++) r = rememberDecided(r, { name: 'w', at: 1000 + i }, 1000 + i);
  assert.equal(r.length, 200);
  r = rememberDecided(r, { name: 'w', at: 1000 + 300 + OPEN_RATE_WINDOW_MS + 1 }, 1000 + 300 + OPEN_RATE_WINDOW_MS + 1);
  assert.equal(r.length, 1);
});
