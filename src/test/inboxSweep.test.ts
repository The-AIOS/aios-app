/**
 * The inbox sweep (The-AIOS/aios-app#218): a request nobody takes is looked at again on a clock.
 *
 * What these tests exercise, and what they do not. The dispatcher that owns the real claim lives
 * in a file that imports the host (Electron), so it cannot run under `node --test`. The sweep is
 * exercised here against a real directory, with real file ages and with NO file events, and the
 * decision it reaches is the real `claimVerdict` with the real `RETIRE_TTL_MS`. The consume used
 * below is a small stand-in for the dispatcher's claim: it asks `claimVerdict` and acts on the
 * answer. That the dispatcher hands its own consume to the sweep is held by the last test, which
 * reads the source.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { claimVerdict, triedBy, fulfillerId, TIMINGS, HOLD_SUFFIX, UNDELIVERED_SUFFIX, type Surface } from '../core/sendQueue';
import { pendingRequests, sweepInbox, startInboxSweep, addresseeRunning, unclaimedReason, INBOX_SWEEP_MS } from '../main/inboxSweep';

const ME: Surface = 'app';
const OTHER: Surface = 'glass';
const MY_ID = fulfillerId(ME, process.pid);
const MIN = 60_000;

function inbox(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'aios-sweep-')); }

/** Drop a request and make it `ageMs` old, the way the dispatcher reads age: from the file's mtime. */
function drop(dir: string, name: string, body: Record<string, unknown>, ageMs: number): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(body));
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(p, when, when);
  return p;
}

/** A stand-in for the dispatcher's claim: the real verdict, then the smallest honest action. */
function consumeIn(surfacesDir: string): (p: string) => void {
  return (p) => {
    const body = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
    const ageMs = Date.now() - fs.statSync(p).mtimeMs;
    const tried = triedBy(body);
    const verdict = claimVerdict(body.surface, ME, ageMs, TIMINGS.RETIRE_TTL_MS, tried, MY_ID);
    if (verdict === 'skip') return;
    if (verdict === 'retire') {
      const reason = tried.includes(MY_ID)
        ? 'handed back for a sibling and no other surface took it'
        : unclaimedReason(String(body.surface), ageMs, addresseeRunning(String(body.surface), () => true, surfacesDir));
      fs.writeFileSync(p + UNDELIVERED_SUFFIX, JSON.stringify({ ...body, _undelivered: { reason } }));
      fs.unlinkSync(p);
      return;
    }
    fs.renameSync(p, p + HOLD_SUFFIX);
  };
}
const reasonOf = (p: string): string => String(JSON.parse(fs.readFileSync(p + UNDELIVERED_SUFFIX, 'utf8'))._undelivered.reason);

test('only *.json is a waiting request; a claimed, finished or documentation file is not', () => {
  const dir = inbox();
  for (const f of ['b.json', 'a.json', 'c.json' + HOLD_SUFFIX, 'd.json' + UNDELIVERED_SUFFIX, 'README.md']) fs.writeFileSync(path.join(dir, f), '{}');
  assert.deepEqual(pendingRequests(dir).map((p) => path.basename(p)), ['a.json', 'b.json']);
  assert.deepEqual(pendingRequests(path.join(dir, 'missing')), [], 'an unreadable inbox holds no requests');
});

test('a request addressed to an absent surface is retired after RETIRE_TTL_MS with no further file event', () => {
  const dir = inbox(); const surfaces = inbox();
  const p = drop(dir, 'kill-nobody.json', { action: 'kill', name: 'nobody', surface: OTHER }, TIMINGS.RETIRE_TTL_MS + MIN);

  /* Before the sweep existed, this is where the request stayed: its one file event came while it
     was fresh, the verdict was `skip`, and nothing asked again. No event is sent here either. */
  assert.ok(fs.existsSync(p) && !fs.existsSync(p + UNDELIVERED_SUFFIX), 'with nobody asking, the request just sits');

  assert.equal(sweepInbox(dir, consumeIn(surfaces)), 1);
  assert.ok(!fs.existsSync(p), 'the request is no longer waiting');
  assert.ok(fs.existsSync(p + UNDELIVERED_SUFFIX), 'it became a dead letter');
  assert.equal(reasonOf(p), `addressed to '${OTHER}', which is not running; unclaimed for 11 min`);
});

test('a request addressed elsewhere and younger than the TTL is left completely alone', () => {
  const dir = inbox();
  const p = drop(dir, 'fresh.json', { action: 'kill', name: 'nobody', surface: OTHER }, TIMINGS.RETIRE_TTL_MS - MIN);
  const before = fs.readFileSync(p, 'utf8');
  sweepInbox(dir, consumeIn(inbox()));
  assert.equal(fs.readFileSync(p, 'utf8'), before, 'the addressee may still be starting up');
  assert.deepEqual(fs.readdirSync(dir), ['fresh.json']);
});

test('a request this instance handed back, and no sibling took, is retired after RETIRE_TTL_MS', () => {
  const dir = inbox();
  const old = drop(dir, 'handed-back.json', { action: 'send', name: 'worker', prompt: 'hi', _tried: [MY_ID], _releases: 1 }, TIMINGS.RETIRE_TTL_MS + MIN);
  const young = drop(dir, 'handed-back-fresh.json', { action: 'send', name: 'worker', prompt: 'hi', _tried: [MY_ID], _releases: 1 }, MIN);
  sweepInbox(dir, consumeIn(inbox()));
  assert.ok(fs.existsSync(old + UNDELIVERED_SUFFIX) && !fs.existsSync(old), 'a sibling had its ten minutes');
  assert.match(reasonOf(old), /handed back/);
  assert.ok(fs.existsSync(young) && !fs.existsSync(young + UNDELIVERED_SUFFIX), 'a sibling may still take the fresh one');
});

test('a request that is ours to take, whose file event was lost, is taken by the next sweep', () => {
  const dir = inbox();
  const mine = drop(dir, 'mine.json', { action: 'kill', name: 'nobody', surface: ME }, 3 * MIN);
  const anyones = drop(dir, 'anyones.json', { action: 'kill', name: 'nobody', _tried: [fulfillerId(OTHER, 1)] }, 3 * MIN);
  sweepInbox(dir, consumeIn(inbox()));
  assert.ok(fs.existsSync(mine + HOLD_SUFFIX) && fs.existsSync(anyones + HOLD_SUFFIX));
  assert.deepEqual(pendingRequests(dir), [], 'nothing is left waiting, so a second sweep has nothing to take twice');
});

test('one request that makes consume throw does not hide the others', () => {
  const dir = inbox();
  drop(dir, 'a-broken.json', {}, MIN); drop(dir, 'b-fine.json', {}, MIN);
  const seen: string[] = [];
  const n = sweepInbox(dir, (p) => { seen.push(path.basename(p)); if (p.includes('broken')) throw new Error('boom'); });
  assert.equal(n, 2);
  assert.deepEqual(seen, ['a-broken.json', 'b-fine.json']);
});

test('the sweep runs on a clock with no file events, and stops when told to', async () => {
  const dir = inbox();
  const p = drop(dir, 'absent.json', { action: 'kill', name: 'nobody', surface: OTHER }, TIMINGS.RETIRE_TTL_MS + MIN);
  let calls = 0;
  const real = consumeIn(inbox());
  const stop = startInboxSweep(dir, (f) => { calls++; real(f); }, 15);
  await new Promise((r) => setTimeout(r, 120));
  stop();
  assert.ok(fs.existsSync(p + UNDELIVERED_SUFFIX), 'retired by the timer alone');
  assert.equal(calls, 1, 'a retired request is not a request any more, so later ticks hand over nothing');
  drop(dir, 'after-stop.json', { action: 'kill', name: 'nobody', surface: OTHER }, TIMINGS.RETIRE_TTL_MS + MIN);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls, 1, 'a stopped sweep hands over nothing');
  assert.equal(INBOX_SWEEP_MS, 60_000, 'a minute: a retirement lands within about a minute of the TTL');
  assert.ok(INBOX_SWEEP_MS < TIMINGS.RETIRE_TTL_MS, 'the sweep must look more often than a request takes to expire');
});

test('the addressee counts as running only when its record names a live pid from this boot', () => {
  const surfaces = inbox();
  const write = (body: unknown): void => fs.writeFileSync(path.join(surfaces, `${OTHER}.json`), typeof body === 'string' ? body : JSON.stringify(body));
  const alive = (pid: number): boolean => pid === 4242;
  const now = 1_000_000_000_000; const uptimeS = 3600;
  const run = (): boolean => addresseeRunning(OTHER, alive, surfaces, now, uptimeS);

  assert.equal(run(), false, 'no record');
  write('not json'); assert.equal(run(), false, 'a malformed record names nobody');
  write({ surface: OTHER, pid: 99, at: now }); assert.equal(run(), false, 'a record outlives its process');
  write({ surface: OTHER, pid: 4242, at: now - 10 * MIN }); assert.equal(run(), true, 'a live pid, written since boot');
  write({ surface: OTHER, pid: 4242, at: now - 2 * 3600 * 1000 }); assert.equal(run(), false, 'written before this boot: the pid was reused');
  write({ surface: OTHER, pid: 1 }); assert.equal(run(), false, 'pid 1 is never a surface');
  assert.equal(addresseeRunning('../etc/passwd', () => true, surfaces, now, uptimeS), false, 'a surface name is never a path');
});

test('the dead letter names the addressee and says whether it was running', () => {
  assert.equal(unclaimedReason('glass', 12 * MIN, false), "addressed to 'glass', which is not running; unclaimed for 12 min");
  assert.equal(unclaimedReason('app', 10 * MIN + 20_000, true), "addressed to 'app', which is running and did not take it; unclaimed for 10 min");
});

test('INVARIANT: the dispatcher sweeps the inbox with its own consume, and words the dead letter here', () => {
  const src = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  assert.match(src, /startInboxSweep\(dir, \(p\) => consume\(getWin, p\)\)/,
    'the periodic sweep must go through the same consume as a file event; a second code path is a second set of rules');
  assert.match(src, /unclaimedReason\(/, 'a request its addressee never took must be retired with the reason that names the addressee');
  assert.match(src, /addresseeRunning\(/, 'and that reason must say whether the addressee was running');
});
