/**
 * aios-app#253 — on Windows the App types its lines into PowerShell, and they have to parse there.
 *
 * PowerShell escapes a quote inside single quotes by doubling it, not with the POSIX '\'' idiom, and
 * it also ends a single-quoted string at the typographic quotes U+2018 to U+201B. Measured with
 * PowerShell 7.7.0 before this fix:
 *   - the bus quoted its spawn/resume lines the POSIX way. Tasks go by file on win32, but the file's
 *     path holds the Windows user name, and `C:\Users\O'Brien` cut the line: `--name` was swallowed
 *     into an argument and the worker started without its identity, with nothing reporting it;
 *   - the renderer doubled `'` and not `’`: `claude --name w 'don’t stop'` did not parse;
 *   - setup's psq had the same gap, and the French verdict ("N’A PAS ABOUTI") broke done.ps1.
 *
 * One rule now: core/spawnShell's quoteFor, the module aios-glass#59 adds for the same defect in
 * Glass, byte-identical here. With AIOS_PWSH set, a real PowerShell binds every line; without it,
 * those tests skip, as in CI.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { quoteFor, typedShellFor } from '../core/spawnShell';
import { buildSpawnCmd, buildResumeCmd, taskFileInstruction } from '../core/commandBus';

const TYPO = ['\u2018', '\u2019', '\u201a', '\u201b'];
const OBRIEN_FILE = "C:\\Users\\O'Brien\\AppData\\Local\\Temp\\aios-handoff-0123456789abcdef\\aios-spawn-task-w.md";
const OBRIEN_DIR = "C:\\Users\\O'Brien\\AppData\\Local\\Temp\\aios-handoff-0123456789abcdef";
const DARCY_FILE = 'C:\\Users\\D\u2019Arcy\\AppData\\Local\\Temp\\aios-handoff-0123456789abcdef\\aios-resume-task-w.md';
const DARCY_DIR = 'C:\\Users\\D\u2019Arcy\\AppData\\Local\\Temp\\aios-handoff-0123456789abcdef';
const SID = '0f0e8d1c-0000-4000-8000-000000000000';

/* ── the shared rule ───────────────────────────────────────────────────────── */

/* aios-glass#59 adds this file to Glass's src/core, and `npm run sync-core` copies Glass's core here.
   The two must stay the same bytes, or the surfaces quote differently again. If it changes in review
   there, this pin fails until the same bytes land here (and the pin in both repos moves together). */
const SPAWN_SHELL_SHA = 'd8609f769fb201b1';
test('core/spawnShell.ts is byte-identical to the one Glass types with', () => {
  const sha = crypto.createHash('sha256').update(fs.readFileSync('src/core/spawnShell.ts')).digest('hex').slice(0, 16);
  assert.equal(sha, SPAWN_SHELL_SHA, 'core/spawnShell.ts changed. It is shared with aios-glass: make the same edit there and move SPAWN_SHELL_SHA in both.');
  assert.match(fs.readFileSync('scripts/sync-core.mjs', 'utf8'), /'spawnShell\.ts'/, 'sync-core treats it as pinned, never as "glass is ahead"');
});

test('quoteFor: PowerShell doubles the apostrophe and the four typographic quotes; POSIX is unchanged', () => {
  assert.equal(typedShellFor('win32'), 'powershell');
  assert.equal(typedShellFor('darwin'), 'posix');
  assert.equal(typedShellFor('linux'), 'posix');
  assert.equal(quoteFor("don't", 'powershell'), "'don''t'");
  for (const q of TYPO) assert.equal(quoteFor(`a${q}b`, 'powershell'), `'a${q}${q}b'`, `U+${q.codePointAt(0)!.toString(16)}`);
  assert.equal(quoteFor('$(whoami) `n', 'powershell'), "'$(whoami) `n'", 'nothing else needs escaping inside single quotes');
  assert.equal(quoteFor("it's", 'posix'), "'it'\\''s'");
  assert.equal(quoteFor('don\u2019t', 'posix'), "'don\u2019t'", 'a typographic quote is a plain character to zsh and bash');
});

/* ── the bus ───────────────────────────────────────────────────────────────── */

test('bus spawn on Windows: a quote in the user folder no longer swallows --name', () => {
  /* The case that failed silently: the task went by file as designed, and the file's own path broke the line. */
  assert.equal(buildSpawnCmd('claude', 'w', { task: 'x', taskFile: OBRIEN_FILE, shell: 'powershell' }),
    `claude '--add-dir' 'C:\\Users\\O''Brien\\AppData\\Local\\Temp\\aios-handoff-0123456789abcdef' --name w `
    + `'Read C:\\Users\\O''Brien\\AppData\\Local\\Temp\\aios-handoff-0123456789abcdef\\aios-spawn-task-w.md and follow the instructions inside.'`);
  const withAll = buildSpawnCmd('claude', 'w', {
    task: 'x', taskFile: OBRIEN_FILE, model: 'claude-x', shell: 'powershell',
    extraArgs: ['--effort', 'high', '--settings', "C:\\Users\\O'Brien\\AppData\\Local\\Temp\\aios-advisor-1\\settings.json"],
  });
  assert.match(withAll, / '--settings' 'C:\\Users\\O''Brien\\AppData\\Local\\Temp\\aios-advisor-1\\settings\.json' /);
  assert.doesNotMatch(withAll, /'\\''/, 'no POSIX idiom on a PowerShell line');
});

test('bus resume on Windows: same rule, typographic quote included', () => {
  assert.equal(buildResumeCmd('claude', SID, { prompt: 'x', taskFile: DARCY_FILE, shell: 'powershell' }),
    `claude '--add-dir' 'C:\\Users\\D\u2019\u2019Arcy\\AppData\\Local\\Temp\\aios-handoff-0123456789abcdef' --resume '${SID}' `
    + `'Read C:\\Users\\D\u2019\u2019Arcy\\AppData\\Local\\Temp\\aios-handoff-0123456789abcdef\\aios-resume-task-w.md and follow the instructions inside.'`);
});

test('bus on macOS and Linux: the typed lines do not change', () => {
  const f = "/home/o'b/.aios/run/handoff-x/aios-spawn-task-w.md";
  assert.equal(buildSpawnCmd('claude', 'w', { task: 'x', taskFile: f }), buildSpawnCmd('claude', 'w', { task: 'x', taskFile: f, shell: 'posix' }));
  assert.equal(buildSpawnCmd('claude', 'w', { task: 'x', taskFile: f }),
    `claude '--add-dir' '/home/o'\\''b/.aios/run/handoff-x' --name w '${taskFileInstruction(f).replace(/'/g, `'\\''`)}'`);
});

/* Comments stripped: a doc comment that describes the old idiom must not count as the old idiom. */
const code = (file: string): string => fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('wiring: the bus hands the pane\'s dialect to both builders', () => {
  const src = code('src/main/commandBus.ts');
  assert.match(src, /import \{ typedShellFor \} from '\.\.\/core\/spawnShell';/);
  assert.match(src, /buildSpawnCmd\([^;]*shell: typedShellFor\(process\.platform\)/, 'spawn');
  assert.match(src, /buildResumeCmd\([^;]*shell: typedShellFor\(process\.platform\)/, 'resume');
});

test('wiring: no PowerShell quoter of its own is left in main — setup and the spilled step quote through quoteFor', () => {
  const aios = code('src/main/aios.ts');
  assert.match(aios, /function psq\(s: string\): string \{\s*return quoteFor\(String\(s\), 'powershell'\);\s*\}/);
  assert.match(aios, /function shq\(p: string\): string \{\s*return quoteFor\(String\(p\), 'posix'\);\s*\}/);
  assert.match(code('src/main/main.ts'), /return `& \$\{quoteFor\(file, 'powershell'\)\}`;/, 'the spilled .ps1 path holds the user name too');
  for (const f of ['src/main/aios.ts', 'src/main/main.ts', 'src/main/commandBus.ts', 'src/core/commandBus.ts', 'renderer/app.js']) {
    assert.doesNotMatch(code(f), /\.replace\(\/'\/g, "''"\)/, `${f}: doubling only ' is the gap this closes`);
  }
});

/* ── the renderer (plain script: it cannot import src/core, so it mirrors it) ── */

const app = fs.readFileSync('renderer/app.js', 'utf8');
const grab = (re: RegExp, what: string): string => { const m = re.exec(app); assert.ok(m, `${what} must be findable`); return m![0]; };
const rendererQuoters = (isWin: boolean): { shq: (s: string) => string; xQuote: (s: string) => string } => new Function('IS_WIN', [
  grab(/const PS_SINGLE_QUOTES = .*;/, 'PS_SINGLE_QUOTES'),
  grab(/function shq\(s\) \{[\s\S]*?\n\}/, 'shq'),
  grab(/const xQuote = \(p\) => \{[\s\S]*?\n\};/, 'xQuote'),
  'return { shq, xQuote };',
].join('\n'))(isWin);
const CORPUS = ['plain', "don't", 'don\u2019t stop', 'say \u2018hi\u2019 $(whoami)', '\u201alow\u201b', "C:\\Users\\O'Brien\\x", 'a\'\u2019\'b', ''];

test('renderer shq is core\'s quoteFor, on Windows and elsewhere', () => {
  const win = rendererQuoters(true), posix = rendererQuoters(false);
  for (const s of CORPUS) {
    assert.equal(win.shq(s), quoteFor(s, 'powershell'), `win: ${JSON.stringify(s)}`);
    assert.equal(posix.shq(s), quoteFor(s, 'posix'), `posix: ${JSON.stringify(s)}`);
  }
});

test('renderer xQuote quotes the same way when it quotes, and leaves a clean path bare', () => {
  const win = rendererQuoters(true), posix = rendererQuoters(false);
  assert.equal(win.xQuote('C:\\Users\\x\\notes.md'), 'C:\\Users\\x\\notes.md');
  assert.equal(posix.xQuote('/Users/x/notes.md'), '/Users/x/notes.md');
  for (const s of CORPUS.filter((c) => /[^A-Za-z0-9._/\\:-]/.test(c))) {
    assert.equal(win.xQuote(s), quoteFor(s, 'powershell'), `win: ${JSON.stringify(s)}`);
  }
  assert.equal(win.xQuote('C:\\Users\\D\u2019Arcy\\a.md'), "'C:\\Users\\D\u2019\u2019Arcy\\a.md'", 'a typographic quote forces quoting and is doubled');
});

/* ── a real PowerShell (AIOS_PWSH) ─────────────────────────────────────────── */

const PWSH = process.env.AIOS_PWSH;
const needPwsh = PWSH && fs.existsSync(PWSH) ? false : 'set AIOS_PWSH to a PowerShell 7 binary to run this';

function withStub<T>(fn: (bind: (line: string) => string[] | { error: string }) => T): T {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'app-pwsh-'));
  try {
    const stub = path.join(tmp, 'claude.ps1');
    fs.writeFileSync(stub, 'function claude { ConvertTo-Json -Compress -InputObject @($args) }\n');
    return fn((line) => {
      try {
        const out = execFileSync(PWSH as string, ['-NoProfile', '-NonInteractive', '-Command', `. '${stub}'; ${line}`],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
        return JSON.parse(out) as string[];
      } catch (e) { return { error: String((e as { stderr?: string }).stderr || e) }; }
    });
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

test('PowerShell binds the bus lines whole — and the POSIX-quoted ones did not (control)', { skip: needPwsh }, () => withStub((bind) => {
  const spawnArgs = ['--add-dir', OBRIEN_DIR, '--name', 'w', taskFileInstruction(OBRIEN_FILE)];
  assert.deepEqual(bind(buildSpawnCmd('claude', 'w', { task: 'x', taskFile: OBRIEN_FILE, shell: 'powershell' })), spawnArgs);
  assert.deepEqual(bind(buildResumeCmd('claude', SID, { prompt: 'x', taskFile: DARCY_FILE, shell: 'powershell' })),
    ['--add-dir', DARCY_DIR, '--resume', SID, taskFileInstruction(DARCY_FILE)]);
  const settings = "C:\\Users\\O'Brien\\AppData\\Local\\Temp\\aios-advisor-1\\settings.json";
  assert.deepEqual(bind(buildSpawnCmd('claude', 'w', { task: 'x', taskFile: OBRIEN_FILE, model: 'claude-x', shell: 'powershell', extraArgs: ['--effort', 'high', '--settings', settings] })),
    ['--add-dir', OBRIEN_DIR, '--model', 'claude-x', '--name', 'w', '--effort', 'high', '--settings', settings, taskFileInstruction(OBRIEN_FILE)]);
  /* The fail-before: the same request quoted the old way. */
  assert.notDeepEqual(bind(buildSpawnCmd('claude', 'w', { task: 'x', taskFile: OBRIEN_FILE, shell: 'posix' })), spawnArgs, 'POSIX quoting must not bind in PowerShell — if it does, this test measures nothing');
}));

test('PowerShell binds a renderer task holding \u2019, \u2018, \' and $(…) as one verbatim argument — and the old quoter did not (control)', { skip: needPwsh }, () => withStub((bind) => {
  const win = rendererQuoters(true);
  const oldWin = (s: string): string => `'${s.replace(/'/g, "''")}'`;
  for (const task of ['don\u2019t stop', 'say \u2018hi\u2019 $(whoami)', "it's \u201alow\u201b"]) {
    assert.deepEqual(bind(`claude --name w ${win.shq(task)}`), ['--name', 'w', task], task);
  }
  assert.notDeepEqual(bind(`claude --name w ${oldWin('don\u2019t stop')}`), ['--name', 'w', 'don\u2019t stop'], 'the control: doubling only \' leaves \u2019 closing the string');
}));

test('PowerShell runs the French setup verdict — the old psq stopped at its \u2019 (control)', { skip: needPwsh }, async () => {
  const fr = JSON.parse(fs.readFileSync('src/i18n/locales/fr.json', 'utf8')) as Record<string, unknown>;
  const get = (k: string): string => {
    const v = k.split('.').reduce<unknown>((o, p) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[p] : undefined), fr) ?? fr[k];
    assert.equal(typeof v, 'string', `fr ${k}`);
    return v as string;
  };
  const fail = get('term.doneFail'), failSub = get('term.doneFailSub');
  assert.match(fail + failSub, /\u2019/, 'the French strings still carry a typographic apostrophe, or this case is moot');
  /* bannerScript writes the Windows body only on win32, so the platform is lent to it for one call. */
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const aios = await import('../main/aios');
  let invocation = '';
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try { invocation = aios.bannerScript('OK', 'ok sub', fail, failSub); } finally { Object.defineProperty(process, 'platform', real); }
  const script = /-File '(.+)'$/.exec(invocation)?.[1]?.replace(/''/g, "'") ?? '';
  assert.ok(script && fs.existsSync(script), `banner script not written: ${invocation}`);
  const run = (file: string): string => execFileSync(PWSH as string, ['-NoProfile', '-NonInteractive', '-File', file, 'False'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
  const out = run(script);
  assert.ok(out.includes(fail) && out.includes(failSub), out);
  /* The control: the same body with only ' doubled. */
  const old = fs.readFileSync(script, 'utf8').split(fail.replace(/\u2019/g, '\u2019\u2019')).join(fail).split(failSub.replace(/\u2019/g, '\u2019\u2019')).join(failSub);
  const oldFile = path.join(path.dirname(script), 'done-old.ps1');
  fs.writeFileSync(oldFile, old);
  try { assert.throws(() => run(oldFile), /ParserError|Unexpected token|missing the terminator/i); }
  finally { fs.rmSync(oldFile, { force: true }); }
});
