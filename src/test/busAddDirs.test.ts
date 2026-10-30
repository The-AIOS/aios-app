/**
 * Bus `addDirs` tests — extra directories a bus-launched session may work in, each its own
 * `--add-dir`. Every entry is validated like `cwd` (absolute, existing, a directory, inside home
 * after symlinks); one entry that cannot be honoured refuses the whole request naming it, and the
 * flags land straight after the binary, where the variadic `--add-dir` cannot swallow the prompt.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveBusAddDirs } from '../main/busCwd';
import { parseRequest, fallbackSpawnRequest, buildSpawnCmd, buildResumeCmd, shq, taskFileInstruction } from '../core/commandBus';

function sandbox(): { home: string; outside: string; done: () => void } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'busadddirs-')));
  const home = path.join(root, 'home');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(home, 'dev', 'repo'), { recursive: true });
  fs.mkdirSync(path.join(home, 'dev', 'other'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(home, 'file.txt'), 'x');
  return { home, outside, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('addDirs: existing directories inside home are accepted, resolved, in order, deduplicated', () => {
  const s = sandbox();
  try {
    const repo = path.join(s.home, 'dev', 'repo');
    const other = path.join(s.home, 'dev', 'other');
    assert.deepEqual(resolveBusAddDirs([repo, other], s.home), { dirs: [repo, other] });
    assert.deepEqual(resolveBusAddDirs([path.join(s.home, 'dev', '..', 'dev', 'repo'), repo], s.home), { dirs: [repo] },
      'the same directory written twice is granted once');
    assert.deepEqual(resolveBusAddDirs([], s.home), { dirs: [] }, 'an empty list is no directories');
    assert.deepEqual(resolveBusAddDirs([s.home], s.home), { dirs: [s.home] }, 'home itself is inside home');
  } finally { s.done(); }
});

test('addDirs: an entry that cannot be honoured refuses the request, naming it by index', () => {
  const s = sandbox();
  try {
    const repo = path.join(s.home, 'dev', 'repo');
    const refused: Array<[unknown, RegExp]> = [
      ['dev/repo', /absolute/],
      ['~/dev/repo', /absolute/],
      ['', /non-empty/],
      [42, /non-empty string/],
      [path.join(s.home, 'nope'), /does not exist/],
      [path.join(s.home, 'file.txt'), /not a directory/],
      [s.outside, /inside the home/],
      [path.join(s.home, '..', 'outside'), /inside the home/],
      [path.join(s.home, 'a\0b'), /control character/],
      [path.join(s.home, 'dev', 'repo') + '\n', /control character/],
      [{ toString: 0 }, /non-empty string/],
      ['/' + 'a'.repeat(5000), /too long/],
    ];
    for (const [raw, why] of refused) {
      const r = resolveBusAddDirs([repo, raw], s.home);
      assert.ok('error' in r, `${JSON.stringify(raw).slice(0, 40)} must be refused`);
      assert.match((r as { error: string }).error, /^addDirs\[1\] '/, 'the dead letter names the entry');
      assert.match((r as { error: string }).error, why);
    }
  } finally { s.done(); }
});

test('addDirs: an object element is refused by name, never thrown (String() throws on {"toString":0})', () => {
  const s = sandbox();
  try {
    const raw = JSON.parse('[{"toString":0}]');
    const r = resolveBusAddDirs(raw, s.home);
    assert.ok('error' in r);
    assert.match((r as { error: string }).error, /^addDirs\[0\] '\{"toString":0\}' is not valid/);
    assert.match((resolveBusAddDirs(JSON.parse('{"toString":0}'), s.home) as { error: string }).error, /^addDirs '\{"toString":0\}'/);
  } finally { s.done(); }
});

test('addDirs: an apostrophe is fine where shq quotes it (POSIX), refused on Windows (PowerShell)', () => {
  const s = sandbox();
  try {
    const odd = path.join(s.home, "it's");
    fs.mkdirSync(odd);
    assert.deepEqual(resolveBusAddDirs([odd], s.home, 'darwin'), { dirs: [odd] });
    for (const q of ["it's", 'it\u2019s']) {
      const r = resolveBusAddDirs([path.join(s.home, q)], s.home, 'win32');
      assert.ok('error' in r, `${q} must be refused on win32`);
      assert.match((r as { error: string }).error, /^addDirs\[0\] '.*PowerShell/);
    }
  } finally { s.done(); }
});

test('addDirs: a clean name that resolves to a name with a control character is refused (what is typed is the real path)',
  { skip: process.platform === 'win32' ? 'a Windows file name cannot hold a control character, so this case cannot arise there' : false }, () => {
  const s = sandbox();
  try {
    const nl = path.join(s.home, 'dev', 'line\nbreak');
    fs.mkdirSync(nl);
    fs.symlinkSync(nl, path.join(s.home, 'clean'));
    const r = resolveBusAddDirs([path.join(s.home, 'clean')], s.home, 'darwin');
    assert.ok('error' in r);
    assert.match((r as { error: string }).error, /^addDirs\[0\] '.*clean' is not valid — it resolves to .*control character/s);
  } finally { s.done(); }
});

test('addDirs: on Windows, a clean name that resolves to a name with a quote is refused', () => {
  const s = sandbox();
  try {
    const q = path.join(s.home, 'dev', "it's");
    fs.mkdirSync(q);
    fs.symlinkSync(q, path.join(s.home, 'plain'), 'junction');
    const r = resolveBusAddDirs([path.join(s.home, 'plain')], s.home, 'win32');
    assert.ok('error' in r);
    assert.match((r as { error: string }).error, /^addDirs\[0\] '.*plain' is not valid — it resolves to .*PowerShell/s);
  } finally { s.done(); }
});

test('addDirs: not a list, or too many, is refused naming the field', () => {
  const s = sandbox();
  try {
    for (const raw of ['/a/b', 7, { dir: '/a' }, true]) {
      const r = resolveBusAddDirs(raw, s.home);
      assert.ok('error' in r, `${JSON.stringify(raw)} must be refused`);
      assert.match((r as { error: string }).error, /^addDirs '.*' is not valid — it must be a list/);
    }
    const many = resolveBusAddDirs(Array(17).fill(path.join(s.home, 'dev', 'repo')), s.home);
    assert.ok('error' in many);
    assert.match((many as { error: string }).error, /at most 16/);
  } finally { s.done(); }
});

test('addDirs: a symlink inside home that points out of home is refused', () => {
  const s = sandbox();
  try {
    const link = path.join(s.home, 'escape');
    fs.symlinkSync(s.outside, link);
    const r = resolveBusAddDirs([link], s.home);
    assert.ok('error' in r);
    assert.match((r as { error: string }).error, /^addDirs\[0\] '.*inside the home/);
  } finally { s.done(); }
});

test('addDirs: a sibling whose name only starts with home is not inside it', () => {
  const s = sandbox();
  try {
    const sibling = s.home + '-other';
    fs.mkdirSync(sibling);
    assert.ok('error' in resolveBusAddDirs([sibling], s.home));
  } finally { s.done(); }
});

test('parseRequest carries addDirs as written; a malformed value is kept so it is refused, not dropped', () => {
  assert.deepEqual(parseRequest('{"name":"g","addDirs":["/a/b","/c"]}')!.addDirs, ['/a/b', '/c']);
  assert.deepEqual(parseRequest('{"action":"resume","name":"g","addDirs":["/a/b"],"fallback":"spawn"}')!.addDirs, ['/a/b']);
  assert.equal(parseRequest('{"name":"g"}')!.addDirs, undefined);
  assert.equal(parseRequest('{"name":"g","addDirs":null}')!.addDirs, undefined);
  assert.equal(parseRequest('{"name":"g","addDirs":"/a/b"}')!.addDirs, '/a/b');
  assert.deepEqual(parseRequest('{"name":"g","addDirs":[7]}')!.addDirs, [7]);
  assert.deepEqual(fallbackSpawnRequest(parseRequest('{"action":"resume","name":"g","prompt":"p","fallback":"spawn","addDirs":["/r"]}')!).addDirs, ['/r'],
    'the fallback spawn keeps the directories');
});

test('commands: one --add-dir per directory, straight after the binary, before the task file folder', () => {
  assert.equal(buildSpawnCmd('claude', 'w', { task: 'go', addDirs: ['/h/dev/repo', '/h/dev/other'] }),
    `claude '--add-dir' '/h/dev/repo' '--add-dir' '/h/dev/other' --name w 'go'`);
  assert.equal(buildSpawnCmd('claude', 'w', { task: 'long', model: 'claude-x', addDirs: ['/h/it\'s'], taskFile: '/h/.aios/run/x/t.md' }),
    `claude '--add-dir' ${shq("/h/it's")} '--add-dir' '/h/.aios/run/x' --model claude-x --name w ${shq(taskFileInstruction('/h/.aios/run/x/t.md'))}`);
  assert.equal(buildResumeCmd('claude', 'abc', { prompt: 'p', addDirs: ['/h/dev/repo'] }),
    `claude '--add-dir' '/h/dev/repo' --resume 'abc' 'p'`);
  assert.equal(buildSpawnCmd('claude', 'w', { task: 'go', addDirs: [] }), `claude --name w 'go'`, 'none → no flag, as before');
  assert.equal(buildSpawnCmd('claude', 'w', { task: 'go' }), `claude --name w 'go'`);
});

test('INVARIANT: both launches validate addDirs and hand them to the command', () => {
  const src = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  assert.equal((src.match(/const addDirs = launchAddDirs\(heldPath, req\);\s*\n\s*if \(!addDirs\) return;/g) || []).length, 2,
    'spawn and resume both resolve addDirs and stop on a dead letter');
  assert.match(src, /buildSpawnCmd\(aios\.shellSettings\(\)\.claudeCmd, req\.name, \{\s*task: [^}]*addDirs,/, 'spawn passes the directories');
  assert.match(src, /buildResumeCmd\(aios\.shellSettings\(\)\.claudeCmd, sid, \{[^}]*addDirs,/, 'resume passes the directories');
  assert.match(src, /function launchAddDirs[\s\S]*?markUndelivered\(heldPath, req, r\.error\); return null;/, 'a bad entry is dead-lettered');
});
