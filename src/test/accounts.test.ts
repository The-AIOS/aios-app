/**
 * The account list as the framework gives it. The JSON below is the real output of
 * `claude-identity.sh switch --availability` over a fixture HOME, not a shape written from
 * memory, so a change of contract shows up here.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parseAvailability, rowsFromUserMd, nextDestination, canSwitchTo, rowLabel } from '../core/accounts';

const REAL = JSON.stringify([
  {
    "email": "first@example.com",
    "alias": "one",
    "plan": "",
    "rotation": true,
    "reason": "",
    "state": "active",
    "detail": "5h 1% · 7d 4%, read 1h ago, renews Thu 05/11 00:35",
    "capped_until": null,
    "five_hour_pct": 1,
    "seven_day_pct": 4,
    "seven_day_pct_read": 4,
    "weekly_renews_at": 1793849723.472227,
    "weekly_renewed_since_reading": false,
    "refresh_expires_at": null,
    "refresh_expires_source": "",
    "reading_recorded_at": 1793414123
  },
  {
    "email": "second@example.com",
    "alias": "",
    "plan": "max",
    "rotation": true,
    "reason": "",
    "state": "expired",
    "detail": "needs a new login first, see claude-switch --help; 5h 1% · 7d 98%, read 1h ago, renews Mon 02/11 00:35",
    "capped_until": null,
    "five_hour_pct": 1,
    "seven_day_pct": 98,
    "seven_day_pct_read": 98,
    "weekly_renews_at": 1793590523.472227,
    "weekly_renewed_since_reading": false,
    "refresh_expires_at": 1793331323.472,
    "refresh_expires_source": "saved",
    "reading_recorded_at": 1793414123
  },
  {
    "email": "third@example.com",
    "alias": "",
    "plan": "",
    "rotation": true,
    "reason": "",
    "state": "capped",
    "detail": "7d at 99% until Tue 03/11 00:35, then back to 0%",
    "capped_until": 1793676923.472227,
    "five_hour_pct": 1,
    "seven_day_pct": 99,
    "seven_day_pct_read": 99,
    "weekly_renews_at": 1793676923.472227,
    "weekly_renewed_since_reading": false,
    "refresh_expires_at": 1796009723.472,
    "refresh_expires_source": "saved",
    "reading_recorded_at": 1793414123
  },
  {
    "email": "parked@example.com",
    "alias": "",
    "plan": "",
    "rotation": false,
    "reason": "kept for manual use",
    "state": "out-of-rotation",
    "detail": "5h 1% · 7d 10%, read 1h ago, renews Wed 04/11 00:35",
    "capped_until": null,
    "five_hour_pct": 1,
    "seven_day_pct": 10,
    "seven_day_pct_read": 10,
    "weekly_renews_at": 1793763323.472227,
    "weekly_renewed_since_reading": false,
    "refresh_expires_at": 1796009723.472,
    "refresh_expires_source": "saved",
    "reading_recorded_at": 1793414123
  }
]);
const A = 'first@example.com', B = 'second@example.com', C = 'third@example.com', D = 'parked@example.com';

test('reads the script\'s real answer', () => {
  const rows = parseAvailability(REAL)!;
  assert.deepEqual(rows.map((r) => [r.email, r.state]), [
    [A, 'active'], [B, 'expired'], [C, 'capped'], [D, 'out-of-rotation'],
  ]);
  assert.equal(rows[0].alias, 'one');
  assert.equal(rows[3].rotation, false);
  assert.match(rows[0].detail, /renews/);
});

test('an unreadable answer is "could not ask", never "no accounts"', () => {
  for (const bad of ['', 'not json', '{}', 'null', '[{"state":"active"}]', '[{"email":"a@b.c"}]', '[null]']) {
    assert.equal(parseAvailability(bad), null, bad);
  }
  assert.deepEqual(parseAvailability('[]'), []);
});

test('the destination is the first available account, not the next one down', () => {
  const rows = parseAvailability(REAL)!;
  assert.equal(nextDestination(rows, A), '', 'expired, capped and out of rotation are not destinations');
  rows[2].state = 'available';
  assert.equal(nextDestination(rows, A), C, 'passes over the expired one');
  rows[3].state = 'available';
  rows[2].state = 'capped';
  assert.equal(nextDestination(rows, A), '', 'available, but out of rotation');
});

test('never the account you are on', () => {
  const rows = parseAvailability(REAL)!;
  rows[0].state = 'available';
  assert.equal(nextDestination(rows, A), '');
});

test('what can be picked by hand', () => {
  const by = Object.fromEntries(parseAvailability(REAL)!.map((r) => [r.email, canSwitchTo(r)]));
  assert.deepEqual(by, { [A]: false, [B]: false, [C]: true, [D]: true });
});

test('a state this version has not met passes through, and is not a destination', () => {
  const rows = parseAvailability('[{"email":"a@b.c","state":"active"},{"email":"d@e.f","state":"something-new"}]')!;
  assert.equal(rows[1].state, 'something-new');
  assert.equal(nextDestination(rows, 'a@b.c'), '');
});

const OLD = `# USER

## Anthropic accounts (quota management)

> A note that mentions someone@example.com in prose.

1. \`${A}\` — alias **one** · primary
2. \`${B}\`
3. \`${C}\` — overflow

## Next
1. \`notanaccount@example.com\`
`;

test('an older framework: the list from USER.md, and nothing claimed about it', () => {
  const rows = rowsFromUserMd(OLD, A);
  assert.deepEqual(rows.map((r) => r.email), [A, B, C]);
  assert.equal(rows[0].state, 'active');
  assert.equal(rows[0].alias, 'one');
  assert.equal(rows[1].state, 'unknown');
  assert.deepEqual(rowsFromUserMd('# no section\n', A), []);
});

test('an older framework: the next one down, and it wraps, as before', () => {
  const rows = rowsFromUserMd(OLD, A);
  assert.equal(nextDestination(rows, A), B);
  assert.equal(nextDestination(rowsFromUserMd(OLD, C), C), A);
  assert.equal(nextDestination(rowsFromUserMd(OLD, 'other@example.com'), 'other@example.com'), A);
  assert.equal(nextDestination(rowsFromUserMd('## Anthropic accounts\n1. `a@b.c`\n', 'a@b.c'), 'a@b.c'), '');
});

test('labels', () => {
  const rows = parseAvailability(REAL)!;
  assert.equal(rowLabel(rows[0]), `one (${A})`);
  assert.equal(rowLabel(rows[1]), B);
});
