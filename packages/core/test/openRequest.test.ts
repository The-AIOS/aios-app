/**
 * The `open` verb (contract 5), run against the framework's own conformance fixture (copied
 * verbatim, through cases.lock.json, from skills/aios/orchestration-ladder/inbox-contract-5.
 * conformance.json), then against a real directory of toy files for what a fixture cannot show:
 * links and hard links on a real disk, permission bits, that a secret is refused without being
 * read, and that `readChecked` shows only what was checked.
 *
 * No test here reads a real secret: every file is created in a temporary folder and removed.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  decideOpen, readChecked, isSecretPath, windowsShape, rememberDecided,
  OPEN_MAX_AGE_MS, OPEN_RATE_MAX, OPEN_FLOOD_MAX, OPEN_RATE_WINDOW_MS, OPEN_MAX_LINE, OPEN_MAX_NAME,
  type OpenFs, type OpenClass,
} from '../src/openRequest';

type Entry = { kind: 'file'; class: OpenClass; executable?: boolean; links?: number } | { kind: 'dir' } | { kind: 'other' } | { kind: 'symlink'; to: string };
interface Fixture {
  contract: number;
  constants: Record<string, number>;
  home: string; roots: string[]; fs: Record<string, Entry>;
  cases: { case: string; request: Record<string, unknown>; age_ms: number; present_at_start?: boolean; recent?: { name: string; ago_ms: number }[]; expect: Record<string, unknown> }[];
  windows_paths: { case: string; path: string; why: string | null }[];
}
const FIX = path.join(__dirname, '..', '..', 'cases', 'inbox-contract-5.conformance.json');
const fx = JSON.parse(fs.readFileSync(FIX, 'utf8')) as Fixture;

/** The fixture's file system: resolution follows links in every segment and applies `..` after. */
function fixtureFs(e: Record<string, Entry>): OpenFs & { calls: string[] } {
  const calls: string[] = [];
  const exists = (p: string): boolean => p in e || Object.keys(e).some((k) => k.startsWith(p.replace(/\/$/, '') + '/'));
  let ino = 0;
  const inodes = new Map<string, number>();
  return {
    calls,
    realpath(p) {
      calls.push(p);
      let queue = p.split('/').filter(Boolean);
      let out: string[] = [];
      let hops = 0;
      while (queue.length) {
        const c = queue.shift() as string;
        if (c === '.') continue;
        if (c === '..') { out.pop(); continue; }
        const cand = '/' + [...out, c].join('/');
        const n = e[cand];
        if (n && n.kind === 'symlink') {
          if (++hops > 40) return null;
          queue = [...n.to.split('/').filter(Boolean), ...queue];
          out = [];
          continue;
        }
        out.push(c);
      }
      const r = '/' + out.join('/');
      return exists(r) ? r : null;
    },
    stat(real) {
      const n = e[real];
      if (!inodes.has(real)) inodes.set(real, ++ino);
      const base = { dev: 1, ino: inodes.get(real) as number };
      if (!n || n.kind === 'dir') return { kind: 'dir', links: 1, executable: false, ...base };
      if (n.kind !== 'file') return { kind: 'other', links: 1, executable: false, ...base };
      return { kind: 'file', links: n.links ?? 1, executable: !!n.executable, ...base };
    },
    classify(real) { const n = e[real]; return n && n.kind === 'file' ? n.class : 'binary'; },
  };
}

test('the fixture is contract 5, and its numbers are this module\'s', () => {
  assert.equal(fx.contract, 5);
  assert.ok(fx.cases.length >= 80);
  assert.deepEqual(fx.constants, {
    max_age_ms: OPEN_MAX_AGE_MS, rate_max: OPEN_RATE_MAX, flood_max: OPEN_FLOOD_MAX,
    rate_window_ms: OPEN_RATE_WINDOW_MS, max_line: OPEN_MAX_LINE, max_name: OPEN_MAX_NAME,
  });
});

const NOW = 1_000_000_000_000;
for (const c of fx.cases) {
  test(`conformance: ${c.case}`, () => {
    const ffs = fixtureFs(fx.fs);
    const decided = (c.recent ?? []).map((r) => ({ name: r.name, at: NOW - r.ago_ms }));
    const d = decideOpen({ body: c.request, seenAgoMs: c.age_ms, presentAtStart: !!c.present_at_start, nowMs: NOW, roots: fx.roots, home: fx.home, decided, fs: ffs, platform: 'linux' });
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

test('checks 1 to 7 make no file system call for a path outside the roots, nor for a secret, nor for a bad request', () => {
  for (const p of ['/home/op/notes/out.md', '/etc/passwd', '/home/op/aios/vault/.env', 'relative.md']) {
    const ffs = fixtureFs(fx.fs);
    decideOpen({ body: { name: 'w1', path: p }, seenAgoMs: 0, nowMs: NOW, roots: fx.roots, home: fx.home, decided: [], fs: ffs, platform: 'linux' });
    assert.ok(!ffs.calls.includes(p), `${p} was resolved before the text checks refused it`);
  }
});

for (const w of fx.windows_paths) {
  test(`conformance (windows path): ${w.case}`, () => {
    const p = w.path.trim();
    const got = windowsShape(p) ?? (isSecretPath(p) ? 'secret' : null);
    assert.equal(got, w.why);
  });
}

test('a refusal names neither the resolved path nor anything outside what was written', () => {
  const ffs = fixtureFs(fx.fs);
  const d = decideOpen({ body: { name: 'w1', path: '/home/op/aios/vault/key-link.md' }, seenAgoMs: 0, nowMs: NOW, roots: fx.roots, home: fx.home, decided: [], fs: ffs, platform: 'linux' });
  assert.equal(d.do === 'refuse' && d.why, 'unavailable');
  assert.ok(d.do === 'refuse' && !d.reason.includes('.ssh'), 'the resolved target of a link never appears in the dead letter');
});

/* ── the same decision on a real disk ─────────────────────────────────────────────────── */
const made: string[] = [];
after(() => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* gone */ } } });
function disk(): { base: string; root: string; at: (rel: string, text?: string) => string } {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aios-open-')));
  made.push(base);
  const root = path.join(base, 'home', 'vault');
  fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(path.join(base, 'home', 'outside'));
  return { base, root, at: (rel, text = 'x\n') => { const p = path.join(base, 'home', rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, text); return p; } };
}
const ask = (p: string, d: { base: string; root: string }, extra: Record<string, unknown> = {}) =>
  decideOpen({ body: { action: 'open', name: 'w1', path: p, ...extra }, seenAgoMs: 1000, nowMs: Date.now(), roots: [d.root], home: path.join(d.base, 'home'), decided: [] });
const posix = process.platform !== 'win32';

test('real disk: a note inside the root opens, at its resolved path, with its identity', () => {
  const d = disk(); const p = d.at('vault/note.md');
  const r = ask(p, d);
  assert.equal(r.do, 'open');
  assert.equal(r.do === 'open' && r.path, p);
  assert.ok(r.do === 'open' && r.identity.ino > 0);
});

test('real disk: a hard link to a file outside the roots is refused', { skip: !posix && 'hard links need care on Windows' }, () => {
  const d = disk(); const target = d.at('outside/key.txt'); const link = path.join(d.root, 'meeting.md');
  fs.linkSync(target, link);
  assert.equal((ask(link, d) as { why?: string }).why, 'hard-link');
});

test('real disk: a link inside the root that points outside is refused, and the dead letter does not name the target', { skip: !posix && 'symlinks need privileges on Windows' }, () => {
  const d = disk(); const target = d.at('outside/private.md'); const link = path.join(d.root, 'innocent.md');
  fs.symlinkSync(target, link);
  const r = ask(link, d);
  assert.equal(r.do === 'refuse' && r.why, 'unavailable');
  assert.ok(r.do === 'refuse' && !r.reason.includes('outside'));
});

test('real disk: a linked folder inside the root resolves to where it points', { skip: !posix && 'symlinks need privileges on Windows' }, () => {
  const d = disk(); const p = d.at('vault/real/note.md');
  fs.symlinkSync(path.join(d.root, 'real'), path.join(d.root, 'alias'));
  const r = ask(path.join(d.root, 'alias', 'note.md'), d);
  assert.equal(r.do === 'open' && r.path, p);
});

test('real disk: a link loop is unavailable, and does not hang', { skip: !posix && 'symlinks need privileges on Windows' }, () => {
  const d = disk();
  fs.symlinkSync(path.join(d.root, 'b'), path.join(d.root, 'a'));
  fs.symlinkSync(path.join(d.root, 'a'), path.join(d.root, 'b'));
  assert.equal((ask(path.join(d.root, 'a'), d) as { why?: string }).why, 'unavailable');
});

test('real disk: a secret by name is refused WITHOUT being read', { skip: !posix && 'permission bits are POSIX' }, () => {
  const d = disk(); const p = d.at('vault/.env', 'TOY=not-a-secret\n');
  fs.chmodSync(p, 0o000);   // unreadable: if the decision read it, it would fail differently
  try { assert.equal((ask(p, d) as { why?: string }).why, 'secret'); } finally { fs.chmodSync(p, 0o600); }
});

test('real disk: a file with the execute bit is refused; the same text without it opens', { skip: !posix && 'permission bits are POSIX' }, () => {
  const d = disk(); const p = d.at('vault/run.sh', '#!/bin/sh\necho hi\n');
  fs.chmodSync(p, 0o755);
  assert.equal((ask(p, d) as { why?: string }).why, 'executable');
  fs.chmodSync(p, 0o644);
  assert.equal(ask(p, d).do, 'open');
});

test('real disk: a binary is refused, never handed on', () => {
  const d = disk(); const p = d.at('vault/blob.dat', 'a\u0000b');
  assert.equal((ask(p, d) as { why?: string }).why, 'unreadable');
});

test('real disk: a pipe is not a file, and deciding on it does not block', { skip: !posix && 'fifos are POSIX' }, () => {
  const d = disk(); const p = path.join(d.root, 'pipe');
  require('node:child_process').execFileSync('mkfifo', [p]);
  assert.equal((ask(p, d) as { why?: string }).why, 'not-a-file');
});

test('real disk: the home folder listed as a root is ignored', () => {
  const d = disk(); const p = d.at('outside/private.md');
  const r = decideOpen({ body: { name: 'w1', path: p }, seenAgoMs: 0, nowMs: Date.now(), roots: [path.join(d.base, 'home'), d.root], home: path.join(d.base, 'home'), decided: [] });
  assert.equal(r.do === 'refuse' && r.why, 'unavailable');
});

test('readChecked shows the file that was checked, and refuses a swap made after the decision', { skip: !posix && 'symlinks need privileges on Windows' }, () => {
  const d = disk(); const p = d.at('vault/note.md', 'the note\n'); const secret = d.at('outside/private.md', 'PRIVATE\n');
  const r = ask(p, d);
  assert.ok(r.do === 'open');
  if (r.do !== 'open') return;
  const o = { roots: [d.root], home: path.join(d.base, 'home') };
  assert.deepEqual(readChecked(p, r.identity, o), { ok: true, path: p, content: 'the note\n' });
  fs.rmSync(p); fs.symlinkSync(secret, p);   // the session swaps the note for a link after the open
  const again = readChecked(p, r.identity, o);
  assert.equal(again.ok, false);
  assert.ok(!('content' in again), 'nothing of the swapped file is returned');
  fs.rmSync(p); fs.writeFileSync(p, 'a different file at the same name\n');   // replaced by another file
  assert.equal(readChecked(p, r.identity, o).ok, false, 'a different inode is a different file');
});

test('the secret rule: what it refuses and what it leaves alone', () => {
  for (const s of ['C:\\Users\\op\\repo\\.ENV', '/v/.ssh/notes.md', '/v/agent-secrets/x.md', '/r/token.json', '/r/gcp-oauth-client.json',
    '/r/storage_state.json', '/r/.git/config', '/v/.obsidian/plugins/x/data.json', '/r/service-account-prod.json', '/r/db.kdbx', '/r/id_ecdsa']) {
    assert.equal(isSecretPath(s), true, s);
  }
  for (const s of ['/v/id_card.md', '/r/id_ed25519.pub', '/v/notes.md', '/v/tokenomics.md', '/v/secrets-of-sales.md', '/v/cookie-recipes.md', '/r/.github/ci.yml', '/r/known_hosts']) {
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
