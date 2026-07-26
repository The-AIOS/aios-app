/**
 * Batch F tests — AI-58 sort-anywhere v2 (shared pure core + .glass/state.json
 * prefs) and calendar ISO week numbers. Same fixture pattern as shell.test.ts:
 * aios.ts reads GLASS_FRAMEWORK_PATH at call time.
 */
import { test, before } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { compareEntries, sortEntries, resolveSort, owningRoot, normalizeSortMode, setFolderSort, FOLDER_SORT_KEY, MASTER_SORT_KEY } from '../core/sort';
import * as aios from '../main/aios';

let root = '';

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-app-sortcal-'));
  process.env.GLASS_FRAMEWORK_PATH = root;
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Test framework\n');
  fs.mkdirSync(path.join(root, 'vault', '01 - calendar', '2026-07'), { recursive: true });
  fs.writeFileSync(path.join(root, 'vault', '01 - calendar', '2026-07', '2026-07-20.md'), '# note\n');
});

// ── the shared pure core (synced from aios-glass/src/files/sort.ts) ─────────

test('compareEntries: folders always precede files, both modes', () => {
  const dir = { name: 'zzz', dir: true, mtime: 0 };
  const file = { name: 'aaa', dir: false, mtime: 9e12 };
  assert.ok(compareEntries(dir, file, 'name') < 0);
  assert.ok(compareEntries(dir, file, 'mtime') < 0);
});

test('sortEntries: name is numeric-prefix friendly; mtime is newest-first with name tiebreak', () => {
  const byName = sortEntries([
    { name: '10 - b', dir: true, mtime: 0 },
    { name: '2 - a', dir: true, mtime: 0 },
  ], 'name').map((e) => e.name);
  assert.deepEqual(byName, ['2 - a', '10 - b']);
  const byMtime = sortEntries([
    { name: 'old', dir: false, mtime: 100 },
    { name: 'new', dir: false, mtime: 200 },
    { name: 'b-same', dir: false, mtime: 200 },
  ], 'mtime').map((e) => e.name);
  assert.deepEqual(byMtime, ['b-same', 'new', 'old']);
});

test('resolveSort: closest-ancestor override wins (longest match), else master', () => {
  const ov = { '/code': 'name', '/code/deep': 'mtime' } as const;
  assert.equal(resolveSort({ ...ov }, '/code/deep/sub', 'name'), 'mtime');
  assert.equal(resolveSort({ ...ov }, '/code/other', 'mtime'), 'name');
  assert.equal(resolveSort({}, '/anywhere', 'mtime'), 'mtime');
  assert.equal(owningRoot(['/a', '/a/b'], '/a/b/c'), '/a/b');
  assert.equal(owningRoot(['/a'], '/ab'), undefined); // prefix ≠ ancestor
});

test('normalizeSortMode + setFolderSort keep explicit name overrides', () => {
  assert.equal(normalizeSortMode('mtime'), 'mtime');
  assert.equal(normalizeSortMode('clock'), 'name');
  const next = setFolderSort({ '/x': 'mtime' }, '/y', 'name');
  assert.equal(next['/y'], 'name'); // no prune-on-name — must survive an mtime master
  assert.equal(next['/x'], 'mtime');
});

// ── the roaming prefs (.glass/state.json) ───────────────────────────────────

test('sort prefs roundtrip through .glass/state.json; master set clears overrides', () => {
  assert.equal(aios.masterSort(), 'name'); // fresh fixture → default
  aios.setFolderSortPref('/tmp/somewhere', 'mtime');
  assert.equal(aios.folderSorts()['/tmp/somewhere'], 'mtime');
  const st1 = JSON.parse(fs.readFileSync(path.join(root, '.glass', 'state.json'), 'utf8'));
  assert.equal(st1[FOLDER_SORT_KEY]['/tmp/somewhere'], 'mtime');
  const after = aios.setMasterSortPref('mtime');
  assert.equal(after.master, 'mtime');
  assert.deepEqual(after.overrides, {}); // "make them all sort this way"
  const st2 = JSON.parse(fs.readFileSync(path.join(root, '.glass', 'state.json'), 'utf8'));
  assert.equal(st2[MASTER_SORT_KEY], 'mtime');
  assert.equal(aios.setFolderSortPref('/tmp/x', 'garbage').overrides['/tmp/x'], 'name'); // coerced
});

// ── calendar week numbers ────────────────────────────────────────────────────

test('getMonthData carries an ISO week number per week row', () => {
  const d = aios.getMonthData(2026, 7);
  assert.equal(d.weekNums.length, d.weeks.length); // parallel arrays
  assert.equal(d.weekNums[0], 27);                 // 2026-07-01 sits in ISO W27
  for (let i = 1; i < d.weekNums.length; i++) assert.equal(d.weekNums[i], d.weekNums[i - 1] + 1);
  assert.ok(d.weeks.flat().some((c) => c.date === '2026-07-20' && c.hasNote)); // fixture note still lands
});

test('shellSettings: showWeekNumbers defaults on and persists off', () => {
  assert.equal(aios.shellSettings().showWeekNumbers, true);
  aios.setShellSetting('showWeekNumbers', false);
  assert.equal(aios.shellSettings().showWeekNumbers, false);
});
