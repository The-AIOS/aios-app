/**
 * "Needs you" inbox tests — the pure stateful-dismissal keying model
 * (src/core/inbox.ts) plus the fs-backed inboxItems() battery over a fixture
 * framework (same seams as shell.test: GLASS_FRAMEWORK_PATH at call time,
 * injectable running-sessions + clock so nothing depends on this machine).
 */
import { test, before } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isInboxEntityDismissed, dismissInboxEntity, pruneInboxDismissals } from '../core/inbox';
import * as aios from '../main/aios';

// ── the pure keying model ────────────────────────────────────────────────────

test('isInboxEntityDismissed: hidden only while the signature still matches', () => {
  const d = dismissInboxEntity({}, 'session:writer', 'waiting input');
  assert.equal(isInboxEntityDismissed(d, 'session:writer', 'waiting input'), true, 'same signature → stays hidden');
  assert.equal(isInboxEntityDismissed(d, 'session:writer', 'busy'), false, 'changed signature → auto-expires');
  assert.equal(isInboxEntityDismissed(d, 'session:other', 'waiting input'), false, 'other keys unaffected');
});

test('isInboxEntityDismissed: hostile inputs never throw or false-positive', () => {
  assert.equal(isInboxEntityDismissed(undefined, 'k', 'v'), false);
  assert.equal(isInboxEntityDismissed(null, 'k', 'v'), false);
  assert.equal(isInboxEntityDismissed({}, 'toString', 'v'), false, 'prototype keys are not dismissals');
  assert.equal(isInboxEntityDismissed({ k: 1 }, 'k', '1'), true, 'number/string signatures compare as strings');
});

test('dismissInboxEntity is immutable; pruneInboxDismissals drops dead keys', () => {
  const a = dismissInboxEntity({ old: 'x' }, 'new', 'y');
  assert.deepEqual(a, { old: 'x', new: 'y' });
  const pruned = pruneInboxDismissals(a, ['new']);
  assert.deepEqual(pruned, { new: 'y' }, 'keys without a live item are dropped');
  assert.deepEqual(pruneInboxDismissals(undefined, ['x']), {});
});

// ── fs-backed: inboxItems over a fixture framework ──────────────────────────

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

let root = '';

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-inbox-fixture-'));
  process.env.GLASS_FRAMEWORK_PATH = root;
  const w = (rel: string, content: string) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  w('CLAUDE.md', '# Test framework\n');
  const iso = todayIso();
  w(`vault/01 - calendar/${iso.slice(0, 7)}/${iso}.md`, `### Daily

## Agents can handle
- 🤖 **Draft the launch email** _(→ agent: [[email-drafter]])_

## Energy
`);
  w('.aios-update', 'repo=git@github.com:The-AIOS/aios.git\nhash=abc1234def\nsynced=2026-07-01\n');
});

const running = (status: string): aios.RunningAgent[] => [
  { pid: 4242, name: 'writer', status, sessionId: 's1', cwd: '/tmp', startedAt: 1, updatedAt: 2 },
];

test('inboxItems: session-on-input + suggestion + evening nudge consolidate into one battery', () => {
  const items = aios.inboxItems(running('waiting for input'), 20, 4); // 8pm Thursday → close-day nudge
  const kinds = items.map((i) => i.kind);
  assert.ok(kinds.includes('session'), 'blocked session surfaces: ' + JSON.stringify(kinds));
  assert.ok(kinds.includes('suggestion'), 'open go-with-agents task surfaces');
  assert.ok(kinds.includes('nudge'), 'active nudge rides in the same card');
  const sess = items.find((i) => i.kind === 'session')!;
  assert.equal(sess.key, 'session:writer');
  assert.equal(sess.sig, 'waiting for input', 'the status IS the change signature');
  const sug = items.find((i) => i.kind === 'suggestion')!;
  assert.match(sug.label, /launch email/i);
});

test('inboxItems: a busy session does not need the operator', () => {
  const items = aios.inboxItems(running('busy'), 14, 4);
  assert.ok(!items.some((i) => i.kind === 'session'), 'busy is not blocked');
});

test('dismissal hides an item until it changes again (persisted in .glass/state.json)', () => {
  let items = aios.inboxItems(running('waiting for input'), 14, 4);
  const sess = items.find((i) => i.kind === 'session')!;
  aios.dismissInboxItem(sess.key, sess.sig);
  items = aios.inboxItems(running('waiting for input'), 14, 4);
  assert.ok(!items.some((i) => i.key === sess.key), 'dismissed while unchanged');
  // the state roams via .glass/state.json
  const st = JSON.parse(fs.readFileSync(path.join(root, '.glass', 'state.json'), 'utf8'));
  assert.equal(st['aios.inbox.dismissed.v1'][sess.key], 'waiting for input');
  // the session's status changes → the dismissal auto-expires
  items = aios.inboxItems(running('needs permission approval'), 14, 4);
  const back = items.find((i) => i.key === sess.key);
  assert.ok(back, 'changed signature resurfaces the item');
  assert.equal(back!.sig, 'needs permission approval');
});

test('prune: dismissals whose item disappeared are dropped; update key survives', () => {
  aios.dismissInboxItem('session:ghost-of-a-session', 'gone');
  aios.dismissInboxItem('update', 'abc1234def');
  aios.inboxItems([], 14, 4); // ghost key has no live item → pruned on this pass
  const st = JSON.parse(fs.readFileSync(path.join(root, '.glass', 'state.json'), 'utf8'));
  const dismissed = st['aios.inbox.dismissed.v1'];
  assert.ok(!('session:ghost-of-a-session' in dismissed), 'dead key pruned');
  assert.ok('update' in dismissed, 'the async update key is always kept');
});

test('updateInboxItem: only when available, dismissable by local hash, expires when the hash moves', () => {
  assert.equal(aios.updateInboxItem('up-to-date'), null);
  assert.equal(aios.updateInboxItem('unknown'), null);
  // 'update' was dismissed at hash abc1234def in the previous test → hidden
  assert.equal(aios.updateInboxItem('available'), null, 'dismissed at this hash');
  // the update ran — hash moved → the dismissal auto-expires
  fs.writeFileSync(path.join(root, '.aios-update'), 'repo=git@github.com:The-AIOS/aios.git\nhash=fff9999aaa\nsynced=2026-07-20\n');
  const item = aios.updateInboxItem('available');
  assert.ok(item, 'new hash resurfaces the update row');
  assert.equal(item!.kind, 'update');
  assert.equal(item!.sig, 'fff9999aaa');
});
