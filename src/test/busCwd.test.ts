/**
 * Bus `cwd` tests — where a bus-launched session's terminal opens, and the two fixes that travel
 * with it: the field is validated (absolute, existing, a directory, inside home after symlinks)
 * and refused by name when it cannot be honoured; and a `resume` that falls back to a spawn keeps
 * its first message instead of opening with the generic bootstrap.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveBusCwd, grantBusCwd, isBusCwdGranted, setBusRoots } from '../main/busCwd';
setBusRoots(() => ({}));   // no AIOS folder unless a test names one
import { parseRequest, fallbackSpawnRequest, buildSpawnCmd } from '../core/commandBus';

function sandbox(): { home: string; outside: string; done: () => void } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'buscwd-')));
  const home = path.join(root, 'home');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(path.join(home, 'work', 'guard'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(home, 'file.txt'), 'x');
  return { home, outside, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('issue 87 cwd: only the AIOS folder itself, resolved to its real path; anything else is refused naming addDirs (operator rule, 0.14.0)', () => {
  const s = sandbox();
  try {
    const fw = path.join(s.home, 'work');
    assert.deepEqual(resolveBusCwd(path.join(s.home, 'work', '..', 'work'), s.home, { framework: fw }), { cwd: fw });
    for (const d of [path.join(fw, 'guard'), s.home]) {
      const r = resolveBusCwd(d, s.home, { framework: fw }) as { error?: string };
      assert.match(r.error ?? '', /always starts in the AIOS folder.*addDirs/, d);
    }
    if (process.platform === 'darwin' || process.platform === 'win32') {
      assert.match((resolveBusCwd(path.join(s.home, 'WORK', 'guard'), s.home, { framework: fw }) as { error?: string }).error ?? '', /always starts/, 'case-insensitive volume');
    }
  } finally { s.done(); }
});

test('cwd: refused, naming the field, when it cannot be honoured', () => {
  const s = sandbox();
  try {
    const refused: Array<[unknown, RegExp]> = [
      ['work/guard', /absolute/],
      ['~/work/guard', /absolute/],
      ['', /non-empty/],
      [42, /non-empty string/],
      [path.join(s.home, 'nope'), /does not exist/],
      [path.join(s.home, 'file.txt'), /not a directory/],
      [s.outside, /inside the home/],
      [path.join(s.home, '..', 'outside'), /inside the home/],
      [path.join(s.home, 'a\0b'), /NUL/],
      ['/' + 'a'.repeat(5000), /too long/],
    ];
    for (const [raw, why] of refused) {
      const r = resolveBusCwd(raw, s.home);
      assert.ok('error' in r, `${JSON.stringify(raw).slice(0, 40)} must be refused`);
      assert.match((r as { error: string }).error, /^cwd '/, 'the dead letter names the field');
      assert.match((r as { error: string }).error, why);
    }
  } finally { s.done(); }
});

test('cwd: a symlink inside home that points out of home is refused', () => {
  const s = sandbox();
  try {
    const link = path.join(s.home, 'escape');
    fs.symlinkSync(s.outside, link);
    const r = resolveBusCwd(link, s.home);
    assert.ok('error' in r);
    assert.match((r as { error: string }).error, /inside the home/);
  } finally { s.done(); }
});

test('cwd: a sibling whose name only starts with home is not inside it', () => {
  const s = sandbox();
  try {
    const sibling = s.home + '-other';
    fs.mkdirSync(sibling);
    assert.ok('error' in resolveBusCwd(sibling, s.home));
  } finally { s.done(); }
});

test('cwd grant: only what the bus granted opens outside the allowed roots, matched by real path', () => {
  const s = sandbox();
  try {
    const dir = path.join(s.home, 'work', 'guard');
    assert.equal(isBusCwdGranted(dir), false);
    grantBusCwd(dir);
    assert.equal(isBusCwdGranted(dir), true);
    assert.equal(isBusCwdGranted(path.join(s.home, 'work', '..', 'work', 'guard')), true);
    assert.equal(isBusCwdGranted(s.outside), false);
    assert.equal(isBusCwdGranted(path.join(s.home, 'gone')), false);
  } finally { s.done(); }
});

test('parseRequest carries cwd as written; a non-string is kept so it is refused, not dropped', () => {
  assert.equal(parseRequest('{"name":"g","cwd":"/a/b"}')!.cwd, '/a/b');
  assert.equal(parseRequest('{"action":"resume","name":"g","cwd":"/a/b","fallback":"spawn"}')!.cwd, '/a/b');
  assert.equal(parseRequest('{"name":"g"}')!.cwd, undefined);
  assert.equal(parseRequest('{"name":"g","cwd":null}')!.cwd, undefined);
  assert.equal(parseRequest('{"name":"g","cwd":7}')!.cwd, '7');
});

test('resume fallback: the spawn opens with the resume prompt, never the generic bootstrap', () => {
  const req = parseRequest('{"action":"resume","name":"guard","prompt":"handle the brief in /x","fallback":"spawn","tier":"judgment","cwd":"/w"}')!;
  const sp = fallbackSpawnRequest(req);
  assert.equal(sp.action, 'spawn');
  assert.equal(sp.task, 'handle the brief in /x');
  assert.equal(sp.tier, 'judgment');
  assert.equal(sp.cwd, '/w');
  assert.equal(buildSpawnCmd('claude', sp.name, { task: sp.task || 'Start session' }), "claude --name guard 'handle the brief in /x'");
  // a resume with no prompt still bootstraps, as a plain spawn does
  assert.equal(fallbackSpawnRequest(parseRequest('{"action":"resume","name":"guard","fallback":"spawn"}')!).task, undefined);
});

test('INVARIANT: the resume fallback goes through fallbackSpawnRequest, and both launches validate cwd', () => {
  const src = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  assert.match(src, /runSpawn\(win, heldPath, fallbackSpawnRequest\(req\)\)/, 'the fallback must carry the prompt into the spawn');
  assert.equal((src.match(/launchCwd\(heldPath, req\)/g) || []).length, 2, 'spawn and resume both resolve cwd');
  assert.equal((src.match(/'terminal', \{ name: req\.name, cmd, background: true, \.\.\.where \}/g) || []).length, 2,
    'both launches hand the validated cwd to the renderer');
  const mainSrc = fs.readFileSync('src/main/main.ts', 'utf8');
  assert.match(mainSrc, /inAllowed\(opts\.cwd\) \|\| isBusCwdGranted\(opts\.cwd\)/, 'pty:spawn honours a bus-granted cwd');
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  assert.match(app, /case 'terminal':\s*\n\s*\/\/[^\n]*\n\s*await createPane\(\{[^}]*cwd: typeof m\.cwd === 'string'/, 'the renderer passes the cwd to the pane');
});
