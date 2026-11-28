/** Claiming a request: read, decide, TAKE, stamp, PUBLISH. Tested against a disk that is a Map. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claimRequest, recoverClaims, mayAdoptHold, holdAgeMs, claimingPathFor, PARSE_GRACE_MS, UNSTAMPED_HOLD_GRACE_MS, type ClaimFs } from '../src/claim';
import { TIMINGS, HOLD_SUFFIX, parseClaim } from '../src/sendQueue';

const NOW = 1_800_000_000_000;
const TTL = TIMINGS.RETIRE_TTL_MS;

/** A disk: path → { text, mtime }. `calls` records every operation, in order. */
function disk(files: Record<string, { text: string; ageMs?: number }>) {
  const m = new Map(Object.entries(files).map(([k, v]) => [k, { text: v.text, mtimeMs: NOW - (v.ageMs ?? 0) }]));
  const calls: string[] = [];
  const enoent = (): Error => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  const hooks: { beforeRename?: () => void; failWrite?: boolean; onWrite?: (p: string) => void } = {};
  const fs: ClaimFs = {
    readFileSync: (p) => { calls.push(`read ${p}`); const f = m.get(p); if (!f) throw enoent(); return f.text; },
    statSync: (p) => { const f = m.get(p); if (!f) throw enoent(); return { mtimeMs: f.mtimeMs }; },
    renameSync: (a, b) => {
      hooks.beforeRename?.();
      calls.push(`rename ${a} -> ${b}`);
      const f = m.get(a); if (!f) throw enoent();
      m.delete(a); m.set(b, f);
    },
    writeFileSync: (p, data) => {
      calls.push(`write ${p}`);
      hooks.onWrite?.(p);
      if (hooks.failWrite) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      m.set(p, { text: data, mtimeMs: NOW });
    },
    readdirSync: () => [...m.keys()],
    existsSync: (p) => m.has(p),
  };
  return { m, fs, calls, hooks };
}
const req = (o: object): string => JSON.stringify(o);
const claimAs = (surface: 'app' | 'glass', pid: number, fs: ClaimFs, path = 'w.json') =>
  claimRequest(path, { surface, pid, nowMs: NOW, retireTtlMs: TTL, fs });

test('a request is claimed, and its hold carries the stamp', () => {
  const d = disk({ 'w.json': { text: req({ name: 'w', task: 'go' }) } });
  const r = claimAs('app', 10, d.fs);
  assert.equal(r.kind, 'claimed');
  if (r.kind !== 'claimed') return;
  assert.equal(r.heldPath, 'w.json' + HOLD_SUFFIX);
  assert.deepEqual(r.body, { name: 'w', task: 'go' }, 'the body handed back is the request as written');
  assert.deepEqual([...d.m.keys()], ['w.json' + HOLD_SUFFIX], 'the request left the watch glob, and nothing else is left behind');
  const held = JSON.parse(d.m.get(r.heldPath)!.text);
  assert.deepEqual(held._claim, { surface: 'app', pid: 10, at: NOW });
  assert.equal(held._queuedAt, NOW, 'when it first queued is set once, at the first claim');
  assert.equal(held.task, 'go');
  assert.equal(d.m.get(r.heldPath)!.text, JSON.stringify(held, null, 2) + '\n');
});

test('THE ORDER: take under a private name, stamp THAT, then publish the hold', () => {
  const d = disk({ 'w.json': { text: req({ name: 'w' }) } });
  claimAs('app', 10, d.fs);
  const mine = claimingPathFor('w.json', 'app', 10);
  assert.equal(mine, 'w.json.claiming-app-10');
  assert.deepEqual(d.calls.filter((c) => !c.startsWith('read ')), [
    `rename w.json -> ${mine}`,
    `write ${mine}`,
    `rename ${mine} -> w.json${HOLD_SUFFIX}`,
  ]);
  assert.ok(!mine.endsWith('.json') && !mine.endsWith(HOLD_SUFFIX), 'a name no watcher claims and no orphan sweep adopts');
});

test('a hold NEVER exists without its stamp: whatever a sibling reads, at any step, has an owner in it', () => {
  /* The window the simpler order (rename to the hold, then stamp) leaves open: a sibling looking
     for orphans reads the hold between those two steps, finds no `_claim`, and adopts a request
     this process is about to run. Here every file ever visible under the hold's name is checked
     at the moment it appears and at every later write. */
  const d = disk({ 'w.json': { text: req({ name: 'w' }) } });
  const seen: string[] = [];
  const look = (): void => { const h = d.m.get('w.json' + HOLD_SUFFIX); if (h) seen.push(h.text); };
  d.hooks.beforeRename = look;
  d.hooks.onWrite = look;
  claimAs('app', 10, d.fs);
  look();
  assert.ok(seen.length >= 1, 'the hold was observed');
  for (const text of seen) assert.deepEqual(parseClaim(JSON.parse(text)._claim), { surface: 'app', pid: 10, at: NOW });
});

test('REGRESSION: a sibling that takes it first keeps its hold, and the loser touches nothing', () => {
  /* The two-owners race. The old order rewrote `w.json` (re-creating it after the sibling had
     renamed it away) and then renamed that over the sibling's hold. Here the sibling wins between
     our read and our take. */
  const d = disk({ 'w.json': { text: req({ name: 'w', task: 'go' }) } });
  const siblingHold = req({ name: 'w', task: 'go', _claim: { surface: 'glass', pid: 77, at: NOW } });
  d.hooks.beforeRename = () => { d.m.delete('w.json'); d.m.set('w.json' + HOLD_SUFFIX, { text: siblingHold, mtimeMs: NOW }); d.hooks.beforeRename = undefined; };
  const r = claimAs('app', 10, d.fs);
  assert.deepEqual(r, { kind: 'gone' }, 'we lost, and that is not an error');
  assert.equal(d.m.get('w.json' + HOLD_SUFFIX)!.text, siblingHold, 'the winner\'s hold is untouched, byte for byte');
  assert.deepEqual([...d.m.keys()], ['w.json' + HOLD_SUFFIX], 'the request was not re-created, and nothing of ours is left');
  assert.equal(d.calls.some((c) => c.startsWith('write ')), false, 'the loser wrote nothing at all');
});

test('two surfaces racing for one request: exactly one claims it', () => {
  const d = disk({ 'w.json': { text: req({ name: 'w' }) } });
  const a = claimAs('app', 10, d.fs);
  const g = claimAs('glass', 20, d.fs);
  assert.deepEqual([a.kind, g.kind], ['claimed', 'gone']);
  assert.deepEqual(parseClaim(JSON.parse(d.m.get('w.json' + HOLD_SUFFIX)!.text)._claim), { surface: 'app', pid: 10, at: NOW });
});

test('a half-written request is WAITED for, not claimed as empty', () => {
  for (const text of ['', '   ', '{"name":"w","ta', '[]', '"x"', 'null', req({ task: 'no name' }), req({ name: '!!!' })]) {
    const d = disk({ 'w.json': { text, ageMs: 100 } });
    const r = claimAs('glass', 20, d.fs);
    assert.deepEqual(r, { kind: 'wait', afterMs: PARSE_GRACE_MS }, JSON.stringify(text));
    assert.equal(d.m.get('w.json')!.text, text, 'left exactly as it was');
    assert.deepEqual(d.calls.filter((c) => !c.startsWith('read ')), [], 'nothing renamed, nothing written');
  }
});

test('old enough and still not a request: malformed, for the caller to dead-letter — never silently removed', () => {
  const d = disk({ 'w.json': { text: '{"name":"w","ta', ageMs: PARSE_GRACE_MS } });
  const r = claimAs('glass', 20, d.fs);
  assert.equal(r.kind, 'malformed');
  assert.equal(d.m.has('w.json'), true, 'still there: the caller decides, with a reason on record');
  const almost = disk({ 'w.json': { text: '', ageMs: PARSE_GRACE_MS - 1 } });
  assert.equal(claimAs('glass', 20, almost.fs).kind, 'wait', 'one millisecond short is still being written');
});

test('addressed to the other surface: skipped while fresh, retired when nobody came', () => {
  const fresh = disk({ 'w.json': { text: req({ name: 'w', surface: 'glass' }), ageMs: 1000 } });
  assert.deepEqual(claimAs('app', 10, fresh.fs), { kind: 'skip' });
  assert.deepEqual(fresh.calls.filter((c) => !c.startsWith('read ')), [], 'an addressed request is never touched by the other surface');

  const old = disk({ 'w.json': { text: req({ name: 'w', surface: 'glass' }), ageMs: TTL } });
  const r = claimAs('app', 10, old.fs);
  assert.equal(r.kind, 'retire');
  if (r.kind === 'retire') assert.match(r.reason, /addressed to 'glass' but unclaimed for 10 min/);
  assert.equal(old.m.has('w.json'), true, 'retire is the caller\'s write, with the reason');
});

test('the surface can word the dead letter of a request its addressee never took', () => {
  /* The App says whether the addressee was running (#218); the core must not overwrite that. */
  const seen: [Record<string, unknown>, number][] = [];
  const words = (req: Record<string, unknown>, ageMs: number): string => { seen.push([req, ageMs]); return `CALLER: ${String(req.surface)} ${ageMs}`; };
  const f = disk({ 'w.json': { text: req({ name: 'x', surface: 'glass' }), ageMs: TTL } });
  const r = claimRequest('w.json', { surface: 'app', pid: 7, nowMs: NOW, retireTtlMs: TTL, fs: f.fs, unclaimedReason: words });
  assert.equal(r.kind, 'retire');
  if (r.kind === 'retire') assert.equal(r.reason, `CALLER: glass ${TTL}`, 'the caller\'s words, verbatim');
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0].name, 'x', 'given the request as written');
  // handed back by this very instance: the default sentence, the caller is not asked
  const g = disk({ 'h.json': { text: req({ name: 'x', _tried: ['app:7'] }), ageMs: TTL } });
  const h = claimRequest('h.json', { surface: 'app', pid: 7, nowMs: NOW, retireTtlMs: TTL, fs: g.fs, unclaimedReason: words });
  assert.equal(h.kind, 'retire');
  if (h.kind === 'retire') assert.match(h.reason, /handed back for a sibling 10 min ago/);
  assert.equal(seen.length, 1, 'not asked for the handed-back case');
});

test('handed back by this very instance: not re-claimed, and retired when no sibling took it', () => {
  const body = { name: 'w', _tried: ['app:10'] };
  assert.deepEqual(claimAs('app', 10, disk({ 'w.json': { text: req(body), ageMs: 1000 } }).fs), { kind: 'skip' });
  const r = claimAs('app', 10, disk({ 'w.json': { text: req(body), ageMs: TTL } }).fs);
  assert.equal(r.kind, 'retire');
  if (r.kind === 'retire') assert.match(r.reason, /handed back for a sibling 10 min ago and no other surface took it/);
  // a different window of the same surface is a legitimate sibling
  assert.equal(claimAs('app', 11, disk({ 'w.json': { text: req(body), ageMs: 1000 } }).fs).kind, 'claimed');
});

test('a request that vanished before we read it is gone, quietly', () => {
  assert.deepEqual(claimAs('app', 10, disk({}).fs), { kind: 'gone' });
});

test('a claim that cannot be stamped is never run unstamped: the request goes back, to be dead-lettered', () => {
  /* A read-only request file, a full disk. Running it with no stamp would leave a hold any
     sibling adopts, and this process\'s own orphan sweep too. */
  const d = disk({ 'w.json': { text: req({ name: 'w' }) } });
  d.hooks.failWrite = true;
  const r = claimAs('app', 10, d.fs);
  assert.equal(r.kind, 'malformed');
  if (r.kind === 'malformed') assert.match(r.reason, /the claim could not be written into the request \(EACCES\)/);
  assert.deepEqual([...d.m.keys()], ['w.json'], 'back under its own name, for the caller to dead-letter; no hold, no private file');
});

test('recoverClaims: a request a dead process had taken goes back to be claimed again', () => {
  const d = disk({
    'a.json.claiming-app-500': { text: req({ name: 'a' }) },      // its process is gone
    'b.json.claiming-glass-600': { text: req({ name: 'b' }) },    // its process is alive: mid-claim
    'c.json.claiming-app-10': { text: req({ name: 'c' }) },       // ours, right now
    'd.json.claiming-app-501': { text: req({ name: 'd' }) },      // gone, but d.json exists again
    'd.json': { text: req({ name: 'd', task: 'newer' }) },
    'e.json.holding': { text: req({ name: 'e' }) },
    'notes.claiming-app-500': { text: 'not a request name' },
  });
  const restored = recoverClaims('', { pid: 10, isAlive: (pid) => pid === 600, fs: d.fs, join: (_d, n) => n });
  assert.deepEqual(restored, ['a.json']);
  assert.equal(d.m.has('a.json'), true);
  assert.equal(d.m.has('a.json.claiming-app-500'), false);
  assert.equal(d.m.has('b.json.claiming-glass-600'), true, 'a live sibling is in the middle of its claim');
  assert.equal(d.m.has('c.json.claiming-app-10'), true, 'and so are we');
  assert.equal(d.m.has('d.json.claiming-app-501'), true, 'never over a request that reused the name');
  assert.equal(JSON.parse(d.m.get('d.json')!.text).task, 'newer');
  assert.equal(d.m.has('notes.claiming-app-500'), true, 'only request names');
  // and a restored request is claimable like any other
  assert.equal(claimAs('app', 10, d.fs, 'a.json').kind, 'claimed');
});

test('a request that queued before keeps its place: _queuedAt is never moved by a new claim', () => {
  const d = disk({ 'w.json': { text: req({ name: 'w', _queuedAt: 123 }) } });
  const r = claimAs('app', 10, d.fs);
  assert.equal(r.kind, 'claimed');
  assert.equal(JSON.parse(d.m.get('w.json' + HOLD_SUFFIX)!.text)._queuedAt, 123);
});

test('recoverClaims: a claim whose process is alive is never restored, however old it is', () => {
  /* A claimer that is paused between its take and its stamp (a debugger, a suspended machine) will
     stamp and publish when it resumes. Restoring its file meanwhile lets a sibling claim and
     fulfil the request, and then the resumed process fulfils it again. */
  const d = disk({
    'a.json.claiming-glass-600': { text: req({ name: 'a' }), ageMs: 60 * 60 * 1000 },
    'b.json.claiming-app-10': { text: req({ name: 'b' }), ageMs: 60 * 60 * 1000 },
  });
  assert.deepEqual(recoverClaims('', { pid: 10, isAlive: () => true, fs: d.fs, join: (_d, n) => n }), []);
  assert.deepEqual([...d.m.keys()].sort(), ['a.json.claiming-glass-600', 'b.json.claiming-app-10']);
});

test('holdAgeMs: a hold is as old as its last rename or write, not as old as the request it came from', () => {
  /* A rename keeps mtime. A request that waited a minute would look like a minute-old hold the
     instant a sibling renames it, and its not-yet-written stamp would read as an orphan. */
  assert.equal(holdAgeMs({ mtimeMs: NOW - 60_000, ctimeMs: NOW - 5 }, NOW), 5, 'renamed 5 ms ago');
  assert.equal(holdAgeMs({ mtimeMs: NOW - 5, ctimeMs: NOW - 60_000 }, NOW), 5);
  assert.equal(holdAgeMs({ mtimeMs: NOW + 1000, ctimeMs: NOW }, NOW), 0, 'a clock that jumped is not a negative age');
});

test('mayAdoptHold: a hold with no stamp is a sibling mid-claim until it has been a hold for longer than that instant', () => {
  const stale = TIMINGS.HOLD_STALE_MS;
  assert.equal(mayAdoptHold(undefined, NOW, stale, false, 0), false, 'renamed a moment ago, stamp not written yet');
  assert.equal(mayAdoptHold(undefined, NOW, stale, false, UNSTAMPED_HOLD_GRACE_MS - 1), false);
  assert.equal(mayAdoptHold(undefined, NOW, stale, false, UNSTAMPED_HOLD_GRACE_MS), true, 'still unstamped after the grace: an orphan, adoptable as before');
  // a stamped hold is decided exactly as canAdoptHold always decided it, whatever its age on disk
  const live = { surface: 'glass' as const, pid: 77, at: NOW - 1000 };
  assert.equal(mayAdoptHold(live, NOW, stale, true, 0), false, 'a live holder, fresh');
  assert.equal(mayAdoptHold(live, NOW, stale, false, 0), true, 'its holder is gone');
  assert.equal(mayAdoptHold({ ...live, at: NOW - stale }, NOW, stale, true, 0), true, 'a live holder, but the hold went stale');
});

test('ON A REAL DISK: a rename moves ctime and keeps mtime, which is what the unstamped-hold grace stands on', () => {
  /* mayAdoptHold is only as good as holdAgeMs, and holdAgeMs is only right if the filesystem
     really moves ctime on a rename. Measured here, on whatever this suite runs on. */
  const fsReal = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const path = require('node:path') as typeof import('node:path');
  const dir = fsReal.mkdtempSync(path.join(os.tmpdir(), 'aios-claim-'));
  try {
    const a = path.join(dir, 'w.json'), b = path.join(dir, 'w.json.holding');
    fsReal.writeFileSync(a, '{}');
    const old = new Date(Date.now() - 60_000);
    fsReal.utimesSync(a, old, old);                       // a request that waited a minute
    const before = fsReal.statSync(a);                    // utimes itself moves ctime, so read it after
    const until = Date.now() + 50;
    while (Date.now() < until) { /* let the clock move past the filesystem's timestamp grain */ }
    fsReal.renameSync(a, b);
    const st = fsReal.statSync(b);
    assert.equal(st.mtimeMs, before.mtimeMs, 'the rename kept the request\'s mtime');
    assert.ok(Date.now() - st.mtimeMs >= 59_000, 'which says the file is a minute old');
    assert.ok(st.ctimeMs > before.ctimeMs, 'and the rename moved ctime: the hold has a birth time of its own');
    assert.ok(holdAgeMs(st, Date.now()) < 5_000, 'so the hold is seconds old, not a minute');
    // and the real claim, end to end, on the same disk
    const c = path.join(dir, 'x.json');
    fsReal.writeFileSync(c, JSON.stringify({ name: 'x' }));
    const r = claimRequest(c, { surface: 'app', pid: process.pid, nowMs: Date.now(), retireTtlMs: TTL });
    assert.equal(r.kind, 'claimed');
    assert.deepEqual(fsReal.readdirSync(dir).sort(), ['w.json.holding', 'x.json.holding']);
    assert.equal(JSON.parse(fsReal.readFileSync(path.join(dir, 'x.json.holding'), 'utf8'))._claim.pid, process.pid);
  } finally { fsReal.rmSync(dir, { recursive: true, force: true }); }
});
