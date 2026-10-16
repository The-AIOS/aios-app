/** #27 — scheduled-job health, read the way canonical's hooks/aios-health.py reads it (v0.8.12). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { routineRows, routineNeedsAttention } from '../core/routineHealth';

const NOW = Date.parse('2026-10-16T21:00:00Z');
const rec = (name: string, state: string, written: string, until: string, detail = '') =>
  ({ file: `${name}.json`, text: JSON.stringify({ name, state, detail, written_at: written, valid_until: until }) });

test('a job inside its deadline reads as its state; pending reads as waiting', () => {
  const rows = routineRows([
    rec('quota-watch', 'ok', '2026-10-16T20:52:33Z', '2026-10-16T22:22:33Z'),
    rec('backup', 'pending', '2026-10-16T20:00:00Z', '2026-10-16T23:00:00Z'),
    rec('sync', 'fail', '2026-10-16T20:30:00Z', '2026-10-16T22:00:00Z', 'disk full'),
    rec('mail', 'warn', '2026-10-16T20:30:00Z', '2026-10-16T22:00:00Z', 'slow'),
  ], NOW);
  assert.deepEqual(rows.map((r) => [r.name, r.status]), [['backup', 'waiting'], ['mail', 'warn'], ['quota-watch', 'ok'], ['sync', 'fail']], 'sorted by name');
  assert.equal(rows.find((r) => r.name === 'sync')!.detail, 'disk full');
  assert.deepEqual(rows.filter(routineNeedsAttention).map((r) => r.name), ['mail', 'sync']);
});

test('past its deadline a job is OVERDUE — "no result since", whatever it last said', () => {
  const rows = routineRows([
    rec('quota-watch', 'ok', '2026-10-16T18:00:00Z', '2026-10-16T19:30:00Z'),
    rec('never-ran', 'pending', '2026-10-15T00:00:00Z', '2026-10-15T01:00:00Z'),
  ], NOW);
  assert.deepEqual(rows.map((r) => [r.name, r.status, r.state]), [['never-ran', 'overdue', 'pending'], ['quota-watch', 'overdue', 'ok']]);
  assert.ok(rows.every(routineNeedsAttention));
});

test('a broken file is a row, never skipped — a writer that broke is news', () => {
  const rows = routineRows([
    { file: 'garbled.json', text: '{not json' },
    { file: 'missing.json', text: JSON.stringify({ name: 'missing', state: 'ok' }) },
    rec('badstate', 'great', '2026-10-16T20:00:00Z', '2026-10-16T22:00:00Z'),
    rec('backwards', 'ok', '2026-10-16T20:00:00Z', '2026-10-16T19:00:00Z'),
    rec('badtime', 'ok', '2026-10-16 20:00', '2026-10-16T22:00:00Z'),
  ], NOW);
  assert.deepEqual(rows.map((r) => r.status), ['unreadable', 'unreadable', 'unreadable', 'unreadable', 'unreadable']);
  assert.ok(rows.every((r) => r.why));
});

test('dot-files (the writer\'s temp files) and non-JSON files are ignored; nothing in → nothing out', () => {
  assert.deepEqual(routineRows([{ file: '.quota-watch.abc.tmp', text: 'x' }, { file: 'notes.txt', text: 'x' }], NOW), []);
  assert.deepEqual(routineRows([], NOW), []);
});

test('main reads $AIOS_HEALTH_DIR (canonical\'s override), and no directory means no rows', async () => {
  const aios = await import('../main/aios');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-'));
  const prev = process.env.AIOS_HEALTH_DIR;
  try {
    process.env.AIOS_HEALTH_DIR = path.join(dir, 'absent');
    assert.deepEqual(aios.routineHealth(NOW), []);
    process.env.AIOS_HEALTH_DIR = dir;
    const r = rec('quota-watch', 'ok', '2026-10-16T20:52:33Z', '2026-10-16T22:22:33Z');
    fs.writeFileSync(path.join(dir, r.file), r.text);
    assert.deepEqual(aios.routineHealth(NOW).map((x) => [x.name, x.status]), [['quota-watch', 'ok']]);
  } finally {
    if (prev === undefined) delete process.env.AIOS_HEALTH_DIR; else process.env.AIOS_HEALTH_DIR = prev;
  }
});
