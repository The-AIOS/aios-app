/**
 * "Is today closed?" is answered by one line: the `## Close of Day` heading that /aios:close-day
 * writes and /aios:today's precondition greps for (`^## Close of Day`). The nudge used to accept
 * the words anywhere in the note, so a task that mentions them silenced the evening reminder.
 */
import { test, before } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as aios from '../main/aios';

test('only the heading /aios:close-day writes closes the day', () => {
  assert.equal(aios.isDayClosed('# Fri\n\n## Close of Day\n\nShipped.\n'), true);
  assert.equal(aios.isDayClosed('# Fri\r\n\r\n## Close of Day\r\n'), true, 'CRLF note');
  assert.equal(aios.isDayClosed('## Close of Day — 3 shipped\n'), true, 'text after the heading');
});

test('a mention of closing the day is not a closed day', () => {
  for (const md of [
    '- [ ] Prep close of day review\n',
    '- [ ] Run /aios:close-day tonight\n',
    'Notes for the close-of-day block.\n',
    '> 💡 `/aios:drift` _before close of day_\n',
    '### Close the day checklist\n',
    '## Session — close the day early\n',
    '### Close of Day\n',
    '  ## Close of Day\n',
    '## close of day\n',
    'x\r## Close of Day',
    '',
  ]) assert.equal(aios.isDayClosed(md), false, JSON.stringify(md));
});

let root = '';
let note = '';

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-app-closed-'));
  process.env.GLASS_FRAMEWORK_PATH = root;
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Test framework\n');
  const d = new Date();
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  note = path.join(root, 'vault', '01 - calendar', iso.slice(0, 7), `${iso}.md`);
  fs.mkdirSync(path.dirname(note), { recursive: true });
});

test('the evening nudge still asks to close a day whose note only mentions it', () => {
  fs.writeFileSync(note, '# Today\n\n## Rhythm\n- [ ] Prep close of day review\n');
  const n = aios.nudgeState(20, 4, 0);
  assert.equal(n && n.kind, 'close');
  assert.equal(n && n.command, '/aios:close-day');
});

test('the evening nudge goes quiet once the note carries the heading', () => {
  fs.writeFileSync(note, '# Today\n\n## Rhythm\n- [x] Ship\n\n## Close of Day\n\nDone.\n');
  const n = aios.nudgeState(20, 4, 0);
  assert.equal(n, null, 'Thursday 20:00, closed, nothing running: no nudge at all');
});
