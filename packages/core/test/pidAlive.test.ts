/** One pid-liveness rule, tested without a process to signal. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pidAlive, ownPidAlive, type PidProbe } from '../src/pidAlive';
import { buildPresenceRecord, serializePresenceRecord, aliveForRecord, presenceHasCapability, writtenBeforeBoot, BOOT_SLACK_MS } from '../src/presenceRecord';
import { presenceVerdict } from '../src/presence';

const err = (code: string): Error => Object.assign(new Error(code), { code });
const probe = (o: Partial<PidProbe> & { throws?: string }): PidProbe => ({
  signal0: () => { if (o.throws) throw err(o.throws); },
  platform: o.platform ?? 'darwin',
  procStatus: o.procStatus ?? (() => { throw err('ENOENT'); }),
});

test('a pid that takes signal 0 is alive; ESRCH is the only proof it is gone', () => {
  assert.equal(pidAlive(4242, probe({})), true);
  assert.equal(pidAlive(4242, probe({ throws: 'ESRCH' })), false);
  assert.equal(pidAlive(4242, probe({ throws: 'EPERM' })), true, 'EPERM: it exists and is not ours to signal');
  assert.equal(pidAlive(4242, probe({ throws: 'EINVAL' })), true, 'anything but ESRCH reads as alive');
});

test('junk, zero, one and negatives are never alive, and are never signalled', () => {
  let signalled = 0;
  const p: PidProbe = { signal0: () => { signalled++; }, platform: 'darwin', procStatus: () => '' };
  for (const bad of [0, 1, -1, -4242, 1.5, NaN, Infinity, '4242', null, undefined, {}]) assert.equal(pidAlive(bad, p), false, String(bad));
  assert.equal(signalled, 0, 'signal 0 to pid 0 or -1 reaches a whole process group: it must never be sent');
});

test('LINUX: a number that is only a thread of another process is not a live process', () => {
  const thread = probe({ platform: 'linux', procStatus: () => 'Name:\tcontainerd\nTgid:\t1291\nPid:\t1301\n' });
  assert.equal(pidAlive(1301, thread), false, 'signal 0 succeeds for a thread id; its Tgid says whose thread it is');
  const leader = probe({ platform: 'linux', procStatus: () => 'Name:\taios\nTgid:\t1301\nPid:\t1301\n' });
  assert.equal(pidAlive(1301, leader), true);
  assert.equal(pidAlive(1301, probe({ platform: 'linux' })), true, 'no /proc to read: keep the signal\'s answer');
  // and /proc is not consulted anywhere else
  const mac = probe({ platform: 'darwin', procStatus: () => 'Tgid:\t1\n' });
  assert.equal(pidAlive(1301, mac), true);
});

test('the real probe: this process is alive, and a pid nobody has is not', () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(pidAlive(2 ** 22 + 12345), false, 'above the pid ceiling of every platform we run on');
});

test('a record written before the last boot names nobody', () => {
  const now = 1_000_000_000_000, uptime = 3600;   // booted an hour ago
  const boot = now - uptime * 1000;
  assert.equal(writtenBeforeBoot(boot - BOOT_SLACK_MS - 1, now, uptime), true);
  assert.equal(writtenBeforeBoot(boot - BOOT_SLACK_MS + 1, now, uptime), false, 'a minute of slack for clock skew');
  assert.equal(writtenBeforeBoot(now, now, uptime), false);
  for (const junk of [undefined, null, 'x', NaN, Infinity]) assert.equal(writtenBeforeBoot(junk, now, uptime), false, 'no usable timestamp: not judged here');
  assert.equal(writtenBeforeBoot(-Infinity, now, uptime), true, 'a JSON -1e999 is before everything, this boot included');
});

test('aliveForRecord: an old record is dead whatever its pid is doing now', () => {
  const now = 1_000_000_000_000, uptime = 3600;
  const stale = { surface: 'glass', pid: 500, at: now - 2 * 3600 * 1000 };
  const fresh = { surface: 'glass', pid: 500, at: now - 60_000 };
  const everyoneAlive = (): boolean => true;
  assert.equal(aliveForRecord(stale, now, uptime, everyoneAlive)(500), false, 'the pid was reused after the reboot');
  assert.equal(aliveForRecord(fresh, now, uptime, everyoneAlive)(500), true);
  assert.equal(aliveForRecord(fresh, now, uptime, () => false)(500), false);
  assert.equal(aliveForRecord(undefined, now, uptime, everyoneAlive)(500), true);
  // and it plugs into the ownership decision: a stale record is ours to claim
  assert.equal(presenceVerdict(stale, 900, aliveForRecord(stale, now, uptime, everyoneAlive)), 'claim');
  assert.equal(presenceVerdict(fresh, 900, aliveForRecord(fresh, now, uptime, everyoneAlive)), 'leave');
});

test('the presence record has one shape and one serialisation, whichever surface writes it', () => {
  const body = buildPresenceRecord({ surface: 'app', pid: 42, version: '1.2.3', capabilities: ['kill-expect', 'kill-expect', 'a'], nowMs: 7 });
  assert.deepEqual(body, { surface: 'app', pid: 42, at: 7, version: '1.2.3', capabilities: ['a', 'kill-expect'] });
  assert.deepEqual(buildPresenceRecord({ surface: 'glass', pid: 42, version: '0', nowMs: 7 }).capabilities, [], 'always present, never absent');
  assert.equal(serializePresenceRecord(body), JSON.stringify(body, null, 2) + '\n');
  assert.deepEqual(Object.keys(body), ['surface', 'pid', 'at', 'version', 'capabilities']);
});

test('presenceHasCapability tolerates junk', () => {
  assert.equal(presenceHasCapability({ capabilities: ['kill-expect'] }, 'kill-expect'), true);
  assert.equal(presenceHasCapability({ capabilities: ['x'] }, 'kill-expect'), false);
  for (const junk of [undefined, null, {}, { capabilities: 'kill-expect' }, 'x', 7]) assert.equal(presenceHasCapability(junk, 'kill-expect'), false);
});

test('ownPidAlive: for a pid only our own process ever held, EPERM means it is gone', () => {
  /* The surface that stamped a hold is a process of this user, which we can always signal. EPERM
     therefore says the number now belongs to somebody else's process: the holder is dead. */
  assert.equal(ownPidAlive(4242, probe({})), true);
  assert.equal(ownPidAlive(4242, probe({ throws: 'ESRCH' })), false);
  assert.equal(ownPidAlive(4242, probe({ throws: 'EPERM' })), false, 'the opposite of pidAlive, on purpose');
  assert.equal(pidAlive(4242, probe({ throws: 'EPERM' })), true);
  for (const bad of [0, 1, -1, 1.5, NaN, '4242', null, undefined]) assert.equal(ownPidAlive(bad, probe({})), false, String(bad));
  const thread = probe({ platform: 'linux', procStatus: () => 'Tgid:\t1291\n' });
  assert.equal(ownPidAlive(1301, thread), false, 'a thread id is not a process here either');
  assert.equal(ownPidAlive(process.pid), true);
});
