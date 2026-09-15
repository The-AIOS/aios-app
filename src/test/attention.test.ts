/**
 * The attention counter (#22) — sessions blocked on the operator.
 *
 * ONE counter, not two. The design also carried "finished while you were away", which sounds
 * useful and is not: a Dock badge reading 4 beside two waiting sessions cannot be read, because
 * the halves clear by different acts and neither is visible in the total. The operator ran it
 * and said exactly that. The question underneath — *how do you clear a finished one* — has no
 * good answer, because a result you have not read is not something you can act on. So the badge
 * counts what you can act on, and clears when you act.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import {
  attentionTick, markNotified, badgeText, mayBanner, normalizeNotifyLevel, sessionKey,
  BLOCKED_STATUS_RE, isBlockedStatus,
  EMPTY_ATTENTION, NOTIFY_DEFAULT, type AttentionSession, type AttentionState,
} from '../core/attention';

/* `id` defaults to the name because most cases here have one session per name; the duplicate
   tests pass it explicitly, which is the whole reason the field exists. */
const S = (name: string, status: string, waitingFor?: string, id?: string): AttentionSession =>
  ({ id: id ?? name, name, status, ...(waitingFor ? { waitingFor } : {}) });

function run(steps: { sessions: AttentionSession[]; deliver?: boolean }[]) {
  let state: AttentionState = EMPTY_ATTENTION;
  const ticks = [];
  for (const s of steps) {
    const t = attentionTick(state, s.sessions);
    state = s.deliver === false ? t.state : markNotified(t.state, t.pending.map((p) => p.id));
    ticks.push(t);
  }
  return ticks;
}

test('the badge counts blocked sessions, and only those', () => {
  const t = run([{ sessions: [S('a', 'waiting', 'permission'), S('b', 'busy'), S('c', 'idle'), S('d', 'shell')] }]);
  assert.equal(t[0].badge, 1, 'busy, idle and a shell are not waiting on anybody');
  assert.deepEqual(t[0].blocks.map((b) => b.name), ['a']);
});

test('answering is what clears it — and it is the only thing that does', () => {
  const t = run([
    { sessions: [S('writer', 'waiting', 'input needed')] },
    { sessions: [S('writer', 'waiting', 'input needed')] },   // still sitting there
    { sessions: [S('writer', 'busy')] },                      // answered
  ]);
  assert.equal(t[1].badge, 1, 'time passing does not resolve a question');
  assert.equal(t[2].badge, 0);
});

test('a block banners once on entry, not once per poll', () => {
  const blocked = [S('writer', 'waiting', 'input needed')];
  const t = run([{ sessions: blocked }, { sessions: blocked }, { sessions: blocked }]);
  assert.deepEqual(t[0].pending.map((p) => p.name), ['writer'], 'entering the state speaks');
  assert.deepEqual(t[1].pending, [], 'the same unresolved block is not news again');
  assert.deepEqual(t[2].pending, [], 'and still is not, however long it sits');
  assert.equal(t[2].badge, 1, 'but it keeps its badge while it blocks');
});

test('a second block on the same session, once the first was answered, speaks again', () => {
  const t = run([
    { sessions: [S('writer', 'waiting', 'permission')] },
    { sessions: [S('writer', 'busy')] },
    { sessions: [S('writer', 'waiting', 'another one')] },
  ]);
  assert.deepEqual(t[2].pending.map((p) => p.name), ['writer'], 'a NEW block is new news');
});

test('a banner the OS refused is retried, never silently marked as shown', () => {
  const blocked = [S('writer', 'waiting', 'input needed')];
  let state = EMPTY_ATTENTION;
  const first = attentionTick(state, blocked);
  assert.deepEqual(first.pending.map((p) => p.name), ['writer']);
  state = first.state;                                   // notifier failed — nothing marked
  const second = attentionTick(state, blocked);
  assert.deepEqual(second.pending.map((p) => p.name), ['writer'],
    'detected is not accepted: a failed notification leaves the block pending');
  state = markNotified(second.state, ['writer']);
  assert.deepEqual(attentionTick(state, blocked).pending, [], 'and now it rests');
});

test('a session that ends takes its count with it', () => {
  const t = run([
    { sessions: [S('a', 'waiting', 'q'), S('b', 'waiting', 'q')] },
    { sessions: [S('a', 'waiting', 'q')] },
  ]);
  assert.equal(t[0].badge, 2);
  assert.equal(t[1].badge, 1, 'a session that no longer exists cannot still be waiting on you');
});

test('TWO SESSIONS, ONE NAME: counted separately, never collapsed', () => {
  /* Nothing enforces unique names — the registry is one file per PID, so `spawn ingest` twice
     gives two live sessions called `ingest`. Keyed on name they merged silently. */
  const t = run([{ sessions: [S('ingest', 'waiting', 'q1', 'sid-a'), S('ingest', 'idle', undefined, 'sid-b')] }]);
  assert.equal(t[0].badge, 1, 'only one of them is blocked');
  assert.equal(t[0].blocks[0].id, 'sid-a', 'and we know which');
});

test('a banner for one namesake does not silence the other', () => {
  const t = run([
    { sessions: [S('ingest', 'waiting', 'q1', 'sid-a'), S('ingest', 'busy', undefined, 'sid-b')] },
    { sessions: [S('ingest', 'waiting', 'q1', 'sid-a'), S('ingest', 'waiting', 'q2', 'sid-b')] },
  ]);
  assert.deepEqual(t[0].pending.map((p) => p.id), ['sid-a']);
  assert.deepEqual(t[1].pending.map((p) => p.id), ['sid-b'], 'the second blocking is its own news');
});

test('sessionKey prefers sessionId and falls back to the pid, never to the name', () => {
  assert.equal(sessionKey({ sessionId: 'abc', pid: 5 }), 'abc');
  assert.equal(sessionKey({ sessionId: '', pid: 5 }), 'pid:5', 'a record with no id is still unique');
  assert.equal(sessionKey({ sessionId: '   ', pid: 7 }), 'pid:7', 'whitespace is not an id');
  assert.notEqual(sessionKey({ sessionId: '', pid: 1 }), sessionKey({ sessionId: '', pid: 2 }));
});

test('levels: off shows nothing, badge never banners, banner does both', () => {
  assert.equal(badgeText(3, 'off'), '', 'off is genuinely off — no badge either');
  assert.equal(badgeText(3, 'badge'), '3');
  assert.equal(badgeText(0, 'banner'), '', 'zero clears the badge rather than showing a 0');
  assert.equal(mayBanner('badge'), false, 'badge-only is the point of the middle rung');
  assert.equal(mayBanner('banner'), true);
});

test('an unknown or absent level falls back to telling the operator', () => {
  assert.equal(NOTIFY_DEFAULT, 'banner');
  assert.equal(normalizeNotifyLevel(undefined), 'banner');
  assert.equal(normalizeNotifyLevel('nonsense'), 'banner');
  assert.equal(normalizeNotifyLevel(' BADGE '), 'badge', 'case and whitespace are not a preference');
  assert.equal(normalizeNotifyLevel('off'), 'off', 'but a real choice is honoured');
});

test('the counter and the coloured dot answer the SAME question, character for character', () => {
  /* THE BUG THIS EXISTS FOR, reported from a signed build: a session showed the blue "needs you"
     dot and produced no badge and no banner at all. The dot ran a regex; the counter demanded
     `status === 'waiting'`. Two predicates for one question, so the surface that colours and the
     surface that counts disagreed — and the disagreement is invisible, because each is correct
     on its own terms.

     The renderer is plain `.js` and cannot import this module, so the two spellings are pinned
     to each other here instead. If either moves, this fails and names the other. */
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'app.js'), 'utf8');
  const inRenderer = src.match(/if \((\/[^\n]+?\/)\.test\(st\)\) return \{ cls: 'input'/);
  assert.ok(inRenderer, "statusInfo's needs-input test not found — it moved, and this pin is now blind");
  assert.equal(inRenderer[1], String(BLOCKED_STATUS_RE),
    'the renderer decides the blue dot with a different expression than the badge counts with. '
    + 'They must be identical: a dot without a badge is what the operator actually saw.');
});

test('the shared predicate accepts what Claude Code actually writes', () => {
  for (const s of ['waiting', 'waiting for input', 'needs permission approval', 'blocked', 'input needed']) {
    assert.equal(isBlockedStatus(s), true, `"${s}" is a session waiting on you`);
  }
  for (const s of ['busy', 'idle', 'shell', '']) {
    assert.equal(isBlockedStatus(s), false, `"${s}" is not`);
  }
});

test('an OS that refuses banners is REPORTED, not silently absorbed', () => {
  /* The operator chose "badge + notification", got nothing, and had to find macOS System
     Settings unaided — nothing in the App said the OS was refusing. The App is the only party
     that knows: it receives the `failed` event. A toast alone was not enough, because a toast is
     an EVENT and this is a STATE — it stays true until the operator changes it, and the moment
     they go looking is when they open Settings, not the moment it failed. */
  const glue = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'attention.ts'), 'utf8');
  assert.match(glue, /osRefused\(\): boolean \{ return this\.refused; \}/, 'the refusal is readable');
  assert.match(glue, /n\.on\('failed'[\s\S]{0,200}?this\.refused = true;/,
    'set from the OS report, never inferred from a permissions guess');
  assert.match(glue, /n\.on\('show'[\s\S]{0,120}?this\.refused = false;/,
    'and cleared when a banner lands — permission can be granted mid-run, so the state must not stick');
  assert.match(glue, /if \(!this\.toldAboutPermission\)/, 'the toast fires once, never a nag');

  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'app.js'), 'utf8');
  assert.match(app, /window\.glassShell\.attentionRefused\(\)/,
    'and Settings asks, so the control explains itself instead of looking broken');
  assert.match(app, /t\('notify\.osBlocked'\)/, 'in words that name the place to fix it');
});
