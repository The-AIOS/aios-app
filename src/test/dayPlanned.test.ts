/** "Plan your day" asks whether the day was planned, not whether today's note exists (The-AIOS/aios-glass#57,
 *  part of #226). The rule is `core/dayPlanned.ts`, shared byte-identical with AIOS Glass. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { dayPlanned, asksToPlan } from '../core/dayPlanned';

const ROOT = path.join(__dirname, '..', '..');
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf8');

const SESSION_BLOCK = '## Session — 05:36 | worker: closed\n<!-- close-session: x -->\n\n**Wins:**\n- shipped\n';
const CLOSE_OF_DAY = '## Close of Day\n\n### Shipped\n- a\n\n### Rhythm check\n- ok\n';
const HARVESTED = '## Session notes (harvested)\n\n> Reminders harvested from a killed session — move or clear them.\n\n**w** _(s)_\n\n- a\n';

test('a note /aios:today wrote counts as planned, whatever language its title is in', () => {
  assert.equal(dayPlanned('# 2026-11-28 — Daily Plan\n\n## Claude\'s take\nx\n\n## Rhythm\n'), true);
  assert.equal(dayPlanned('# Viernes 4 de septiembre de 2026\n\n## Calendar\n\n## Today I ship\nx\n'), true);
  assert.equal(dayPlanned('# 2026-11-28 — Day One\n\n## Recommended next step\n'), true);
  assert.equal(dayPlanned('# Day\n\n## 🤖 Agents can handle\n- 🤖 x\n'), true);
});

test('a note only appenders wrote is not planned, nor one rebuilt after the fact', () => {
  assert.equal(dayPlanned(''), false);
  assert.equal(dayPlanned('---\n\n' + SESSION_BLOCK), false, '/close-session creates the note with its block');
  assert.equal(dayPlanned(SESSION_BLOCK + '\n' + CLOSE_OF_DAY), false, '`### Rhythm check` is close-day\'s');
  assert.equal(dayPlanned(HARVESTED), false, 'the note Glass\'s post-it harvest creates');
  assert.equal(dayPlanned('---\ntags: [daily, plan, vault]\n---\n# 2026-05-06 — Daily Plan\n\n' + CLOSE_OF_DAY), false);
  assert.equal(dayPlanned(SESSION_BLOCK + '\n```md\n## Rhythm\n```\n'), false, 'a quoted heading');
});

test('when the nudge asks to plan, hour by hour', () => {
  const unplanned = '---\n\n' + SESSION_BLOCK;
  const planned = '# Day\n\n## Rhythm\n- [ ] x\n';
  /* hour → [no note, unplanned, planned, unplanned but closed] */
  const table: Record<number, [boolean, boolean, boolean, boolean]> = {
    0: [true, true, false, false],
    14: [true, true, false, false],
    15: [true, false, false, false], // from 15:00 an unplanned day behaves as it did before
    16: [true, false, false, false],
    17: [true, false, false, false],
    23: [true, false, false, false],
  };
  for (const [h, [none, un, pl, closed]] of Object.entries(table)) {
    const hour = Number(h);
    assert.equal(asksToPlan(null, hour, false), none, `no note at ${hour}h`);
    assert.equal(asksToPlan(unplanned, hour, false), un, `unplanned at ${hour}h`);
    assert.equal(asksToPlan(planned, hour, false), pl, `planned at ${hour}h`);
    assert.equal(asksToPlan(unplanned + '\n' + CLOSE_OF_DAY, hour, true), closed, `closed at ${hour}h`);
  }
});

test('nudgeState asks the shared rule before any other nudge', () => {
  const src = read('src/main/aios.ts');
  const nudge = src.slice(src.indexOf('export function nudgeState'));
  assert.match(nudge, /if \(asksToPlan\(md, hour, isClosed\)\) return plan;/);
  assert.ok(nudge.indexOf('asksToPlan(') < nudge.indexOf('hour >= 17'), 'before the evening nudges');
});

test('the shared module is byte-identical to Glass\'s, when Glass is checked out beside the App', () => {
  const glass = path.join(ROOT, '..', 'aios-glass', 'src', 'core', 'dayPlanned.ts');
  if (!fs.existsSync(glass)) return;
  assert.equal(read('src/core/dayPlanned.ts'), fs.readFileSync(glass, 'utf8'));
});
