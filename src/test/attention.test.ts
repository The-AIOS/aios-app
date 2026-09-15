/**
 * The two attention counters (#22). Every test below is one line of the issue's own
 * acceptance criteria, which is why they read as scenarios rather than as unit assertions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attentionTick, markNotified, badgeText, mayBanner, normalizeNotifyLevel, sessionKey,
  EMPTY_ATTENTION, NOTIFY_DEFAULT, type AttentionSession, type AttentionState,
} from '../core/attention';

/* `id` defaults to the name, because most tests here have one session per name and reading
   `S('writer','waiting')` is clearer than threading an id through every case. The duplicate-name
   tests pass an explicit id — which is the whole point of the parameter existing. */
const S = (name: string, status: string, waitingFor?: string, id?: string): AttentionSession =>
  ({ id: id ?? name, name, status, ...(waitingFor ? { waitingFor } : {}) });

/** Run a sequence of observations, as the 2s poll would. */
function run(steps: { sessions: AttentionSession[]; visible?: string[]; deliver?: boolean }[]) {
  let state: AttentionState = EMPTY_ATTENTION;
  const ticks = [];
  for (const s of steps) {
    const t = attentionTick(state, s.sessions, s.visible ?? []);
    state = s.deliver === false ? t.state : markNotified(t.state, t.pending.map((p) => p.id));
    ticks.push(t);
  }
  return ticks;
}

test('a block banners exactly once on entry, not once per poll', () => {
  const blocked = [S('writer', 'waiting', 'input needed')];
  const t = run([{ sessions: blocked }, { sessions: blocked }, { sessions: blocked }]);
  assert.deepEqual(t[0].pending.map((p) => p.name), ['writer'], 'entering the state speaks');
  assert.deepEqual(t[1].pending, [], 'the same unresolved block is not news again');
  assert.deepEqual(t[2].pending, [], 'and still is not, however long it sits there');
  assert.equal(t[2].badge, 1, 'but it keeps its badge for as long as it blocks');
});

test('looking at a permission does NOT clear it — only answering does', () => {
  const blocked = [S('writer', 'waiting', 'input needed')];
  const t = run([
    { sessions: blocked },
    { sessions: blocked, visible: ['writer'] },   // staring right at it
    { sessions: [S('writer', 'busy')] },        // answered
  ]);
  assert.equal(t[1].badge, 1, 'viewing a block is not resolving it');
  assert.equal(t[2].badge, 0, 'leaving waiting is what clears it');
});

test('a second block on the same session, after the first was resolved, banners again', () => {
  const t = run([
    { sessions: [S('writer', 'waiting', 'permission')] },
    { sessions: [S('writer', 'busy')] },                    // answered → forget it
    { sessions: [S('writer', 'waiting', 'another one')] },  // blocks again
  ]);
  assert.deepEqual(t[0].pending.map((p) => p.name), ['writer']);
  assert.deepEqual(t[1].pending, []);
  assert.deepEqual(t[2].pending.map((p) => p.name), ['writer'], 'a NEW block is new news');
});

test('a banner the OS refused is retried, never silently marked as shown', () => {
  const blocked = [S('writer', 'waiting', 'input needed')];
  let state = EMPTY_ATTENTION;
  const first = attentionTick(state, blocked, []);
  assert.deepEqual(first.pending.map((p) => p.name), ['writer']);
  state = first.state;                                  // notifier THREW — nothing marked
  const second = attentionTick(state, blocked, []);
  assert.deepEqual(second.pending.map((p) => p.name), ['writer'],
    'a failed notification leaves the block pending — detected is not accepted');
  state = markNotified(second.state, ['writer']);       // this time it landed
  assert.deepEqual(attentionTick(state, blocked, []).pending, [], 'and now it rests');
});

test('finishing while hidden is unread; looking at it clears it', () => {
  const t = run([
    { sessions: [S('writer', 'busy')], visible: [] },
    { sessions: [S('writer', 'idle')], visible: [] },       // finished in the background
    { sessions: [S('writer', 'idle')], visible: ['writer'] },   // operator switches to it
  ]);
  assert.deepEqual(t[1].unread, ['writer'], 'a result nobody saw is unread');
  assert.equal(t[1].badge, 1);
  assert.deepEqual(t[2].unread, [], 'becoming visible IS reading it');
  assert.equal(t[2].badge, 0);
});

test('finishing in full view was never unread', () => {
  const t = run([
    { sessions: [S('writer', 'busy')], visible: ['writer'] },
    { sessions: [S('writer', 'idle')], visible: ['writer'] },
  ]);
  assert.deepEqual(t[1].unread, [], 'you watched it finish');
  assert.equal(t[1].badge, 0);
});

test('an unread result never banners — you find out when you look', () => {
  const t = run([
    { sessions: [S('writer', 'busy')] },
    { sessions: [S('writer', 'idle')] },
  ]);
  assert.equal(t[1].badge, 1, 'it counts');
  assert.deepEqual(t[1].pending, [], 'and it stays silent — pending is blocks only');
});

test('a plain shell going idle is not a result anyone is waiting to read', () => {
  const t = run([
    { sessions: [S('term', 'shell')] },
    { sessions: [S('term', 'idle')] },
  ]);
  assert.deepEqual(t[1].unread, [], 'only work that was BUSY can finish');
  assert.equal(t[1].badge, 0);
});

test('the badge is both counters at once, and a closed session takes its count with it', () => {
  const t = run([
    { sessions: [S('a', 'busy'), S('b', 'busy')] },
    { sessions: [S('a', 'waiting', 'permission'), S('b', 'idle')] },   // one blocks, one finishes unseen
    { sessions: [S('a', 'waiting', 'permission')] },                    // b is gone
  ]);
  assert.equal(t[1].badge, 2, 'one block + one unread');
  assert.equal(t[2].badge, 1, 'a session that no longer exists cannot still be waiting on you');
  assert.deepEqual(t[2].unread, [], 'and its unread mark goes with it');
});

test('the App being in the background makes every pane invisible', () => {
  const t = run([
    { sessions: [S('writer', 'busy')], visible: ['writer'] },
    { sessions: [S('writer', 'idle')], visible: [] },   // pane still selected, App behind Chrome
  ]);
  assert.deepEqual(t[1].unread, ['writer'],
    'a focused pane with the App in the background does not count as seen');
});

test('a split shows two panes at once — both count as seen', () => {
  const t = run([
    { sessions: [S('a', 'busy'), S('b', 'busy')], visible: ['a', 'b'] },
    { sessions: [S('a', 'idle'), S('b', 'idle')], visible: ['a', 'b'] },
  ]);
  assert.deepEqual(t[1].unread, [],
    'with two panes tiled the operator is looking at both — counting the unfocused half as unread '
    + 'would badge a result that is on screen in front of them');
  assert.equal(t[1].badge, 0);
});

test('a session finishing in the HIDDEN half of a split is still unread', () => {
  const t = run([
    { sessions: [S('a', 'busy'), S('b', 'busy')], visible: ['a'] },
    { sessions: [S('a', 'busy'), S('b', 'idle')], visible: ['a'] },
  ]);
  assert.deepEqual(t[1].unread, ['b'], 'on screen is the test, not merely open');
});

test('TWO SESSIONS, ONE NAME: they are counted separately, never collapsed', () => {
  /* Operator-reported 2026-09-14: two `ingest` sessions, one working and one idle, made BOTH
     tabs animate. Nothing enforces unique names — the registry is one file per PID, so
     `spawn ingest` twice gives two live sessions called `ingest`. Everything here used to be
     keyed on name, which silently merged them. */
  const t = run([
    { sessions: [S('ingest', 'busy', undefined, 'sid-a'), S('ingest', 'busy', undefined, 'sid-b')] },
    { sessions: [S('ingest', 'waiting', 'permission', 'sid-a'), S('ingest', 'idle', undefined, 'sid-b')] },
  ]);
  assert.equal(t[1].blocks.length, 1, 'only ONE of them is blocked');
  assert.equal(t[1].blocks[0].id, 'sid-a', 'and we know which');
  assert.deepEqual(t[1].unread, ['sid-b'], 'the other finished unseen — a different state entirely');
  assert.equal(t[1].badge, 2, 'one block + one unread, from two sessions sharing a name');
});

test('looking at one of two same-named sessions clears only THAT one', () => {
  const t = run([
    { sessions: [S('ingest', 'busy', undefined, 'sid-a'), S('ingest', 'busy', undefined, 'sid-b')] },
    { sessions: [S('ingest', 'idle', undefined, 'sid-a'), S('ingest', 'idle', undefined, 'sid-b')],
      visible: ['sid-a'] },
  ]);
  assert.deepEqual(t[1].unread, ['sid-b'],
    'seeing one pane must not mark its namesake as read — that is the same collision from the '
    + 'other direction, and it would silently hide a finished result');
});

test('a banner for one namesake does not silence the other', () => {
  const t = run([
    { sessions: [S('ingest', 'waiting', 'q1', 'sid-a'), S('ingest', 'busy', undefined, 'sid-b')] },
    { sessions: [S('ingest', 'waiting', 'q1', 'sid-a'), S('ingest', 'waiting', 'q2', 'sid-b')] },
  ]);
  assert.deepEqual(t[0].pending.map((p) => p.id), ['sid-a']);
  assert.deepEqual(t[1].pending.map((p) => p.id), ['sid-b'],
    'the second one blocking is its own news, even under a shared name');
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
  assert.equal(badgeText(3, 'banner'), '3');
  assert.equal(badgeText(0, 'banner'), '', 'zero clears the badge rather than showing a 0');
  assert.equal(mayBanner('off'), false);
  assert.equal(mayBanner('badge'), false, 'badge-only is the whole point of the middle rung');
  assert.equal(mayBanner('banner'), true);
});

test('an unknown or absent level falls back to telling the operator', () => {
  assert.equal(NOTIFY_DEFAULT, 'banner');
  assert.equal(normalizeNotifyLevel(undefined), 'banner');
  assert.equal(normalizeNotifyLevel('nonsense'), 'banner');
  assert.equal(normalizeNotifyLevel(' BADGE '), 'badge', 'case and whitespace are not a preference');
  assert.equal(normalizeNotifyLevel('off'), 'off', 'but a real choice is honoured');
});
