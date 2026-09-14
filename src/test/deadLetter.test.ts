/**
 * Dead letters reach the NEEDS YOU card (#26, reduced scope).
 *
 * A dead letter is the bus telling you that work an agent asked for did NOT happen and nobody
 * was told. `~/.aios/spawn-inbox/<name>.json` becomes `<name>.json.undelivered` carrying a
 * `_undelivered: { reason, at, surface }` stamp, and then it sits there. Until now the only
 * things that ever looked were `/today` and `/close-day` — so a request dropped at 10am was
 * invisible until the evening ritual, if one ran at all.
 *
 * SURFACE ONLY, and that is a decision rather than an omission. The rituals already handle
 * these properly — they tell a `bus-dead-letter:` from a `bus-unclaimed:`, check whether the
 * target surface is even alive, ask once, and delete the file. A second, worse copy of that
 * logic living in a panel is how the two would drift. The card's job is that the operator
 * LEARNS, on the day it happens; the handling stays where it is already good.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as aios from '../main/aios';

let bus = '';
const write = (file: string, body: unknown): void =>
  fs.writeFileSync(path.join(bus, file), typeof body === 'string' ? body : JSON.stringify(body, null, 2));

before(() => { bus = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-deadletter-')); });
after(() => { try { fs.rmSync(bus, { recursive: true, force: true }); } catch { /* best effort */ } });

test('a dead letter becomes a row naming the verb, the target and the reason', () => {
  write('nightly-audit.json.undelivered', {
    action: 'resume', name: 'nightly-audit', prompt: 'pick up the PR review',
    _undelivered: { reason: 'no transcript found for that name', at: 1757800000000, surface: 'app' },
  });
  const [row, ...rest] = aios.deadLetterItems(bus);
  assert.equal(rest.length, 0, 'one file, one row');
  assert.equal(row.kind, 'deadletter');
  assert.match(row.label, /resume/, 'the verb that failed is named — spawn and resume fail differently');
  assert.match(row.label, /nightly-audit/, 'the target is named');
  assert.equal(row.detail, 'no transcript found for that name', 'the reason is the detail, verbatim');
  assert.equal(row.path, path.join(bus, 'nightly-audit.json.undelivered'), 'the row can open the file it describes');
  assert.equal(row.key, 'dead:nightly-audit.json.undelivered');
});

test('an unreadable dead letter still produces a row — "something was dropped" beats silence', () => {
  write('truncated.json.undelivered', '{"action":"spawn","na');
  const row = aios.deadLetterItems(bus).find((i) => i.key.includes('truncated'));
  assert.ok(row, 'a corrupt file is exactly when the operator most needs telling');
  assert.match(row!.label, /truncated/, 'the name falls back to the filename when the body is unparseable');
  assert.match(row!.label, /spawn/, 'and the verb falls back to spawn, the contract-1 default');
});

test('no bus directory at all is not an error — it is a machine that has never used the bus', () => {
  assert.deepEqual(aios.deadLetterItems(path.join(bus, 'nope', 'nowhere')), []);
});

test('only .undelivered files count — a live request is not a failure', () => {
  write('pending.json', { action: 'spawn', name: 'pending' });
  const keys = aios.deadLetterItems(bus).map((i) => i.key);
  assert.ok(!keys.some((k) => k.includes('pending.json"') || k === 'dead:pending.json'),
    'a queued request is work in flight, not work dropped');
});

test('the signature carries reason AND time — the same name failing again is news', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-deadletter-sig-'));
  const f = 'writer.json.undelivered';
  const at = (reason: string, when: number): string => {
    fs.writeFileSync(path.join(dir, f), JSON.stringify({ action: 'send', name: 'writer', _undelivered: { reason, at: when } }));
    return aios.deadLetterItems(dir)[0].sig;
  };
  const first = at('surface went away mid-claim', 1757800000000);
  assert.equal(at('surface went away mid-claim', 1757800000000), first, 'unchanged file, unchanged signature');
  assert.notEqual(at('prompt exceeded the inline limit', 1757800000000), first, 'a new reason resurfaces a dismissed row');
  assert.notEqual(at('surface went away mid-claim', 1757900000000), first, 'the same reason at a new time is a NEW failure');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('dead letters come FIRST in the battery — severity decides what survives a clipped list', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-deadletter-order-'));
  fs.writeFileSync(path.join(dir, 'dropped.json.undelivered'),
    JSON.stringify({ action: 'spawn', name: 'dropped', _undelivered: { reason: 'r', at: 1 } }));
  const running: aios.RunningAgent[] = [
    { pid: 1, name: 'writer', status: 'waiting for input', sessionId: 's1', cwd: '/tmp', startedAt: 1, updatedAt: 2 },
  ];
  const items = aios.inboxItems(running, 14, 4, dir);
  assert.equal(items[0].kind, 'deadletter',
    'the only row that reports a FAILURE outranks the rows that report a state');
  assert.ok(items.some((i) => i.kind === 'session'), 'and it does not displace the other sources');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the renderer clips the list but never the count, and never the dead letters', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'app.js'), 'utf8');
  assert.match(src, /const INBOX_CAP = \d+;/, 'the cap is a named constant, not a literal buried in a slice');
  assert.match(src, /pulseTitle\(I, 'pInbox', t\('pulse\.inbox'\), rows\.length\)/,
    'the header counts EVERY waiting item — a clipped list that also under-reports is a lie');
  assert.match(src, /pulse\.inboxExpanded \? rows : rows\.slice\(0, INBOX_CAP\)/,
    'clipping is the only thing the cap does; nothing is dropped from the model');
  assert.match(src, /item\.kind === 'deadletter' && item\.path\) pulse\.cmd\('aios\.openOutput', item\.path\)/,
    'clicking a dead letter opens the file — surface only, no new command invented');
  assert.match(src, /item\.kind === 'update' \|\| item\.kind === 'deadletter'\) \? 'st-warn'/,
    'a dropped request is amber, the same weight as an available update');
});
