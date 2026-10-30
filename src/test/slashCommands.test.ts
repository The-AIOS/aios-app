/**
 * The chat composer's slash-command popup: the pure decisions (core/slashCommands.ts) and the disk reading
 * (main/slashCommandsIo.ts, run for real against a throwaway folder tree). Everything the popup offers comes from
 * these two, so a wrong ranking or a command read from the wrong place is caught here without a window.
 * Each guard has a control: the same check on a deliberately broken input must fail.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  BUILTIN_COMMANDS, builtinCommands, mergeSlashCommands, rankSlashCommands, slashCompletion, slashQuery, slashSuggestions, type SlashCommand,
} from '../core/slashCommands';
import { listSlashCommands, pluginCommandDirs, readCommandsDir } from '../main/slashCommandsIo';
import { isSameOrInside } from '../main/pathResolve';

const cmd = (name: string, source: SlashCommand['source'] = 'user', extra: Partial<SlashCommand> = {}): SlashCommand => ({ name, description: '', source, ...extra });
const names = (l: SlashCommand[]): string[] => l.map((c) => c.name);

// ── what the box is asking for ──────────────────────────────────────────────

test('slashQuery: only a lone slash word at the start of the box is a query', () => {
  assert.equal(slashQuery('/'), '');
  assert.equal(slashQuery('/co'), 'co');
  assert.equal(slashQuery('/aios:to'), 'aios:to');
  assert.equal(slashQuery('/ ' ), null, 'a space after the slash: arguments or prose, not a command');
  assert.equal(slashQuery('/compact now'), null, 'arguments have started');
  assert.equal(slashQuery('/compact '), null, 'the completion itself (command + space) closes the popup');
  assert.equal(slashQuery('/a\nb'), null);
  assert.equal(slashQuery(' /co'), null, 'only the very start counts');
  assert.equal(slashQuery('see /co'), null, 'a slash inside a sentence is a path or a fraction');
  assert.equal(slashQuery('/usr/bin/env'), null, 'an absolute path is not a command');
  assert.equal(slashQuery(''), null);
  // control: a looser pattern would have opened on the sentence
  assert.notEqual(/\/([^\s/]*)$/.exec('see /co'), null);
});

// ── the built-in list ───────────────────────────────────────────────────────

test('the built-in list: every name is unique, lower-case, has a usage hint only when it takes arguments, and no alias collides with another command', () => {
  const all = BUILTIN_COMMANDS.map(([n]) => n);
  assert.ok(all.length >= 60, `a complete list (${all.length})`);
  assert.equal(new Set(all).size, all.length, 'no duplicate names');
  for (const n of all) assert.match(n, /^[a-z][a-z0-9-]*$/, n);
  const claimed = new Map<string, string>();
  for (const [n, , aliases] of BUILTIN_COMMANDS) for (const a of aliases ?? []) {
    assert.ok(!all.includes(a), `alias ${a} of ${n} is also a command`);
    assert.equal(claimed.get(a), undefined, `alias ${a} is claimed by ${claimed.get(a)} and ${n}`);
    claimed.set(a, n);
  }
  for (const must of ['help', 'clear', 'compact', 'model', 'resume', 'init', 'mcp', 'config', 'permissions', 'memory', 'rewind', 'status', 'usage', 'plan', 'effort', 'rename', 'export', 'hooks', 'login', 'logout', 'doctor', 'skills', 'plugin', 'add-dir', 'context', 'copy', 'diff', 'exit']) assert.ok(all.includes(must), `${must} is built in`);
  for (const gone of ['upgrade', 'teleport', 'tui', 'version', 'setup-bedrock', 'extra-usage']) assert.ok(!all.includes(gone), `${gone} is left out on purpose`);
});

test('every built-in has a description in every locale, and every description key in the locales names a built-in', () => {
  for (const l of ['en', 'es', 'pt-br']) {
    const loc = JSON.parse(fs.readFileSync(`src/i18n/locales/${l}.json`, 'utf8')) as Record<string, string>;
    for (const c of builtinCommands()) assert.ok(c.descKey && typeof loc[c.descKey] === 'string' && loc[c.descKey].length > 3, `${l}: ${c.descKey}`);
    const known = new Set(BUILTIN_COMMANDS.map(([n]) => `chat.slash.cmd.${n}`));
    const orphans = Object.keys(loc).filter((k) => k.startsWith('chat.slash.cmd.') && !known.has(k));
    assert.deepEqual(orphans, [], `${l}: descriptions for commands that are not in the list`);
    // the word "Claude" is the session's name in this view and never hardcoded: built-in descriptions do not use it
    for (const c of builtinCommands()) assert.doesNotMatch(loc[c.descKey as string], /Claude/, `${l}: ${c.descKey}`);
  }
  // control: a key that is not a built-in is an orphan
  assert.equal(new Set(BUILTIN_COMMANDS.map(([n]) => `chat.slash.cmd.${n}`)).has('chat.slash.cmd.nonsense'), false);
});

// ── merging ─────────────────────────────────────────────────────────────────

test('mergeSlashCommands: a name defined twice is shown once, by built-in, then project, user, plugin', () => {
  const merged = mergeSlashCommands(
    [cmd('deploy', 'plugin'), cmd('standup', 'plugin')],
    [cmd('deploy', 'user'), cmd('compact', 'user')],
    [cmd('deploy', 'project')],
    builtinCommands(),
  );
  const by = Object.fromEntries(merged.map((c) => [c.name, c.source]));
  assert.equal(by.deploy, 'project');
  assert.equal(by.standup, 'plugin');
  assert.equal(by.compact, 'builtin', 'a file named like a built-in does not replace it');
  assert.equal(merged.filter((c) => c.name === 'deploy').length, 1);
  // equal priority: the first list wins (the framework's live copy is passed before the installed cache)
  assert.equal(mergeSlashCommands([cmd('x', 'plugin', { description: 'first' })], [cmd('x', 'plugin', { description: 'second' })])[0].description, 'first');
  // junk in, nothing out
  assert.deepEqual(mergeSlashCommands([null as unknown as SlashCommand, { name: '' } as SlashCommand]), []);
  // control: without the merge a duplicate would be listed twice
  assert.equal([cmd('a'), cmd('a')].length, 2);
});

// ── ranking ─────────────────────────────────────────────────────────────────

const POOL: SlashCommand[] = [
  ...builtinCommands(),
  cmd('aios:today', 'plugin', { plugin: 'aios', description: 'Generate a grounded daily plan' }),
  cmd('aios:close-day', 'plugin', { plugin: 'aios' }),
  cmd('aios:close-session', 'plugin', { plugin: 'aios' }),
  cmd('standup', 'user', { description: 'Write the morning stand-up from the daily note' }),
  cmd('deploy-staging', 'project', { description: 'Push the branch to the staging environment', argumentHint: '[branch]' }),
  cmd('release:notes', 'project'),
];

test('rankSlashCommands: exact, then prefix, then alias, then the part after a plugin prefix, then inside the name, then the description', () => {
  assert.equal(rankSlashCommands(POOL, 'compact')[0].name, 'compact');
  const cl = names(rankSlashCommands(POOL, 'cl'));
  assert.ok(cl.indexOf('clear') >= 0 && cl.indexOf('clear') < cl.indexOf('aios:close-day'), 'a name that starts with the word beats one that only has it after a plugin prefix');
  assert.ok(cl.indexOf('aios:close-day') < cl.indexOf('aios:close-session'));
  // an alias finds its command; /reset is /clear
  assert.equal(rankSlashCommands(POOL, 'reset')[0].name, 'clear');
  // the word after a plugin prefix is what a person remembers
  assert.equal(rankSlashCommands(POOL, 'tod')[0].name, 'aios:today');
  assert.equal(rankSlashCommands(POOL, 'notes')[0].name, 'release:notes');
  // a word inside a hyphenated name
  assert.ok(names(rankSlashCommands(POOL, 'staging')).includes('deploy-staging'));
  // the description is searched, last, for commands that carry one from their file
  assert.deepEqual(names(rankSlashCommands(POOL, 'morning')), ['standup']);
  // nothing matches: nothing is offered
  assert.deepEqual(rankSlashCommands(POOL, 'zzzzzz'), []);
  // control: case does not matter
  assert.deepEqual(names(rankSlashCommands(POOL, 'COMP')), names(rankSlashCommands(POOL, 'comp')));
});

test('rankSlashCommands: with nothing typed it lists what the operator wrote first, then plugins, then the stock commands, alphabetical inside each', () => {
  const all = rankSlashCommands(POOL, '', { limit: 500 });
  const sources = all.map((c) => c.source);
  const firstBuiltin = sources.indexOf('builtin');
  assert.ok(sources.slice(0, firstBuiltin).every((s) => s !== 'builtin') && sources.slice(firstBuiltin).every((s) => s === 'builtin'), 'built-ins come last');
  assert.deepEqual(sources.slice(0, 5), ['project', 'project', 'user', 'plugin', 'plugin']);
  const builtins = names(all.filter((c) => c.source === 'builtin'));
  assert.deepEqual(builtins, [...builtins].sort((a, b) => a.localeCompare(b)));
  assert.equal(rankSlashCommands(POOL, '', { limit: 5 }).length, 5, 'the limit holds');
  assert.equal(all.length, POOL.length, 'nothing is dropped from the browse list');
});

test('rankSlashCommands: equally good matches put the operator\'s own commands before the stock ones, then A-Z', () => {
  const r = names(rankSlashCommands([cmd('close-session', 'user'), cmd('close', 'builtin'), cmd('close-day', 'plugin'), cmd('close-all', 'project')], 'clo'));
  assert.deepEqual(r, ['close-all', 'close-session', 'close-day', 'close']);
  assert.deepEqual(names(rankSlashCommands([cmd('b-two', 'user'), cmd('a-one', 'user')], 'a-')), ['a-one']);
  assert.deepEqual(names(rankSlashCommands([cmd('b-two', 'user'), cmd('a-one', 'user')], '')), ['a-one', 'b-two']);
});

test('slashSuggestions: the whole popup decision — null for prose, [] for a finished word, ranked rows otherwise', () => {
  assert.deepEqual(slashSuggestions(POOL, 'hello'), []);
  assert.deepEqual(slashSuggestions(POOL, '/compact now'), []);
  assert.equal(slashSuggestions(POOL, '/').length, POOL.length, 'a bare slash browses everything');
  assert.equal(slashSuggestions(POOL, '/comp')[0].name, 'compact');
  // a word that already IS a command (or one of its aliases): nothing left to complete, so Enter will send it
  assert.deepEqual(slashSuggestions(POOL, '/compact'), []);
  assert.deepEqual(slashSuggestions(POOL, '/reset'), []);
  assert.deepEqual(slashSuggestions(POOL, '/AIOS:TODAY'), []);
  // but a prefix of one is not finished
  assert.equal(slashSuggestions(POOL, '/compac')[0].name, 'compact');
  assert.equal(slashSuggestions(POOL, '/aios:close')[0].name, 'aios:close-day');
  // control: dropping the exact-word rule would keep offering the very command that was typed
  assert.equal(rankSlashCommands(POOL, 'compact')[0].name, 'compact');
});

test('slashCompletion: the command and a space, ready for arguments', () => {
  assert.equal(slashCompletion({ name: 'compact' }), '/compact ');
  assert.equal(slashCompletion({ name: 'aios:today' }), '/aios:today ');
  assert.equal(slashQuery(slashCompletion({ name: 'compact' })), null, 'the completed text closes the popup');
});

// ── reading from disk, for real ─────────────────────────────────────────────

function tree(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-slash-'));
  for (const [rel, body] of Object.entries(files)) {
    const f = path.join(root, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  }
  return root;
}
const withTree = async (files: Record<string, string>, fn: (root: string) => Promise<void>): Promise<void> => {
  const root = tree(files);
  try { await fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
};
const md = (description: string, hint?: string): string => `---\ndescription: ${description}\n${hint ? `argument-hint: ${hint}\n` : ''}---\nBody that is never read.\n`;

test('readCommandsDir: name from the file, description and argument-hint from the frontmatter, folders namespaced, index and hidden files skipped', async () => {
  await withTree({
    'commands/standup.md': md('Write the stand-up', '[day]'),
    'commands/git/sync.md': md('Pull and rebase'),
    'commands/git/deep/more.md': md('Deeper'),
    'commands/_index.md': md('documentation, not a command'),
    'commands/.hidden.md': md('hidden'),
    'commands/notes.txt': 'not a command',
    'commands/bare.md': 'no frontmatter at all',
  }, async (root) => {
    const list = await readCommandsDir(path.join(root, 'commands'), 'user');
    assert.deepEqual(names(list).sort(), ['bare', 'git:deep:more', 'git:sync', 'standup']);
    const standup = list.find((c) => c.name === 'standup') as SlashCommand;
    assert.equal(standup.description, 'Write the stand-up');
    assert.equal(standup.argumentHint, '[day]');
    assert.equal(standup.source, 'user');
    assert.equal(list.find((c) => c.name === 'bare')?.description, '');
    // a plugin's commands carry the plugin's name as the prefix and as the tag
    const plug = await readCommandsDir(path.join(root, 'commands'), 'plugin', 'acme');
    assert.ok(plug.every((c) => c.name.startsWith('acme:') && c.plugin === 'acme' && c.source === 'plugin'));
    // a folder that does not exist is an empty list, not an error
    assert.deepEqual(await readCommandsDir(path.join(root, 'nope'), 'user'), []);
  });
});

test('readCommandsDir: only the head of a file is read, a symlinked folder is not followed, and a runaway folder is bounded', async () => {
  await withTree({ 'commands/big.md': md('Short') + 'x'.repeat(2_000_000) }, async (root) => {
    const t0 = Date.now();
    const list = await readCommandsDir(path.join(root, 'commands'), 'user');
    assert.equal(list[0].description, 'Short');
    assert.ok(Date.now() - t0 < 2000);
    fs.symlinkSync(root, path.join(root, 'commands', 'loop'));   // a cycle: commands/loop/commands/loop/…
    const again = await readCommandsDir(path.join(root, 'commands'), 'user');
    assert.deepEqual(names(again), ['big'], 'the symlinked folder is skipped');
  });
  const files: Record<string, string> = {};
  for (let i = 0; i < 450; i++) files[`commands/c${String(i).padStart(3, '0')}.md`] = md(`n${i}`);
  await withTree(files, async (root) => {
    assert.equal((await readCommandsDir(path.join(root, 'commands'), 'user')).length, 400, 'capped at 400');
  });
});

test('pluginCommandDirs: user-scope plugins always, project-scope ones only inside their project, and a broken registry is empty', async () => {
  await withTree({
    'plugins/installed_plugins.json': JSON.stringify({ version: 2, plugins: {
      'aios@the-aios': [{ scope: 'user', installPath: '/x/aios/1.0' }],
      'proj@m': [{ scope: 'project', installPath: '/x/proj/1.0', projectPath: '/work/app' }],
      'old@m': [{ installPath: '/x/old/1.0' }],
      'broken@m': [{ scope: 'user' }],
      'weird@m': 'not a list',
    } }),
  }, async (cfg) => {
    /* The expected folders are built with path.join, never typed with `/`: pluginCommandDirs joins with the host's
       separator, so a literal POSIX string here is true on macOS and Linux and false on Windows (it failed CI there). */
    const dir = (plugin: string, ...install: string[]): string => `${plugin}=${path.join(...install, 'commands')}`;
    const aios = dir('aios', '/x/aios/1.0'), old = dir('old', '/x/old/1.0'), proj = dir('proj', '/x/proj/1.0');
    const at = async (cwd: string | null): Promise<string[]> => (await pluginCommandDirs(cfg, cwd)).map((d) => `${d.plugin}=${d.dir}`).sort();
    assert.deepEqual(await at(null), [aios, old]);
    assert.deepEqual(await at('/work/app'), [aios, old, proj]);
    assert.deepEqual(await at('/work/app/src/deep'), await at('/work/app'), 'a subfolder of the project is inside it');
    assert.deepEqual(await at('/work/app2'), await at(null), 'a sibling that merely starts with the same letters is not');
    assert.deepEqual(await pluginCommandDirs(path.join(cfg, 'missing'), null), []);
  });
});

test('isSameOrInside (win32 rules): separators, drive-letter case, trailing separators and a drive root', () => {
  const w = path.win32;
  const inside = (root: string, child: string): boolean => isSameOrInside(root, child, w);
  assert.equal(inside('C:\\work\\app', 'C:\\work\\app'), true, 'the folder itself');
  assert.equal(inside('C:\\work\\app', 'C:\\work\\app\\src\\deep'), true, 'a subfolder');
  assert.equal(inside('C:\\work\\app', 'c:\\work\\app\\src'), true, 'a lower-case drive letter is the same drive');
  assert.equal(inside('C:\\Work\\App', 'c:\\work\\app\\SRC'), true, 'the file system ignores case');
  assert.equal(inside('C:\\work\\app', 'C:/work/app/src'), true, 'forward slashes are the same folder');
  assert.equal(inside('C:/work/app', 'C:\\work\\app\\src'), true, '…whichever side wrote them');
  assert.equal(inside('C:\\work\\app\\', 'C:\\work\\app\\src'), true, 'a trailing separator on the root does not hide its children');
  assert.equal(inside('C:\\work\\app', 'C:\\work\\app\\'), true, '…nor on the child');
  assert.equal(inside('C:\\', 'C:\\work\\app'), true, 'a drive root contains the drive');
  assert.equal(inside('\\\\host\\share\\proj', '\\\\HOST\\share\\proj\\src'), true, 'a UNC share, host in any case');
  // the negative controls: what must NOT match
  assert.equal(inside('C:\\work\\app', 'C:\\work\\app2'), false, 'a sibling that only shares the prefix');
  assert.equal(inside('C:\\work\\app', 'C:\\work\\app2\\src'), false, '…and its children');
  assert.equal(inside('C:\\work\\app\\', 'C:\\work\\application'), false, '…also when the root carries a trailing separator');
  assert.equal(inside('C:\\work\\app', 'D:\\work\\app\\src'), false, 'another drive');
  assert.equal(inside('C:\\work\\app\\src', 'C:\\work\\app'), false, 'a parent is not inside its child');
  assert.equal(inside('C:\\work\\app', 'C:\\work\\app\\..\\other'), false, '`..` is collapsed before comparing');
  assert.equal(inside('\\\\host\\share\\proj', '\\\\host\\share\\proj2'), false, 'a UNC sibling');
  assert.equal(inside('', 'C:\\work'), false, 'an empty root matches nothing (it would be everything)');
  assert.equal(inside('work\\app', 'work\\app\\src'), false, 'relative paths are no answer, not a guess against another host\'s folder');
  assert.equal(isSameOrInside(undefined, 'C:\\work', w), false);
});

test('isSameOrInside (posix rules): unchanged — case-sensitive, and a sibling prefix is not inside', () => {
  const p = path.posix;
  assert.equal(isSameOrInside('/work/app', '/work/app', p), true);
  assert.equal(isSameOrInside('/work/app', '/work/app/src', p), true);
  assert.equal(isSameOrInside('/work/app/', '/work/app/src', p), true, 'a trailing slash on the root');
  assert.equal(isSameOrInside('/', '/work', p), true, 'the root contains everything');
  assert.equal(isSameOrInside('/work/app', '/work/app2', p), false);
  assert.equal(isSameOrInside('/work/app', '/work/App/src', p), false, 'POSIX file systems may tell case apart; the comparison stays exact');
  assert.equal(isSameOrInside('/work/app', '/work/app/../other', p), false);
  assert.equal(isSameOrInside('/work/app', 'C:\\work\\app\\src', p), false, 'a Windows path is not a POSIX path');
});

test('pluginCommandDirs (win32 rules, run from any host): a project-scope plugin applies inside its project however the path is spelled', async () => {
  const w = path.win32;
  await withTree({
    'plugins/installed_plugins.json': JSON.stringify({ version: 2, plugins: {
      'aios@the-aios': [{ scope: 'user', installPath: 'C:\\Users\\me\\.claude\\plugins\\aios\\1.0' }],
      'proj@m': [{ scope: 'project', installPath: 'C:\\Users\\me\\.claude\\plugins\\proj\\1.0', projectPath: 'C:\\Work\\App' }],
      'slash@m': [{ scope: 'local', installPath: 'C:\\p\\slash', projectPath: 'C:/work/slashed/' }],
    } }),
  }, async (cfg) => {
    const at = async (cwd: string | null): Promise<string[]> => (await pluginCommandDirs(cfg, cwd, w)).map((d) => d.plugin).sort();
    assert.deepEqual(await at(null), ['aios']);
    assert.deepEqual(await at('C:\\Work\\App'), ['aios', 'proj'], 'exactly the project');
    assert.deepEqual(await at('c:\\work\\app\\src'), ['aios', 'proj'], 'a lower-case drive letter and different case');
    assert.deepEqual(await at('C:/Work/App/src/deep'), ['aios', 'proj'], 'forward slashes from the renderer');
    assert.deepEqual(await at('C:\\work\\slashed\\x'), ['aios', 'slash'], 'a registry path with forward slashes and a trailing one');
    assert.deepEqual(await at('C:\\Work\\App2'), ['aios'], 'a sibling that only shares the prefix');
    assert.deepEqual(await at('D:\\Work\\App'), ['aios'], 'another drive');
    assert.deepEqual((await pluginCommandDirs(cfg, null, w)).map((d) => d.dir).sort()[0], 'C:\\Users\\me\\.claude\\plugins\\aios\\1.0\\commands', 'the folder is joined with the registry\'s own separator');
  });
});

test('listSlashCommands: built-in + project + user + the framework\'s + installed plugins, merged, from where Claude Code reads them', async () => {
  const cfg = tree({
    'commands/standup.md': md('User stand-up'),
    'commands/compact.md': md('A file that shares a built-in name'),
    'plugins/installed_plugins.json': JSON.stringify({ plugins: { 'aios@the-aios': [{ scope: 'user', installPath: '__PLUGIN__' }] } }),
  });
  const plugin = tree({ 'commands/ship.md': md('Ship it', '[env]'), 'commands/today.md': md('Cached copy of the framework command') });
  const proj = tree({ '.claude/commands/deploy.md': md('Project deploy', '[branch]'), '.claude/commands/standup.md': md('Project stand-up wins over the user one') });
  try {
    const reg = path.join(cfg, 'plugins', 'installed_plugins.json');
    fs.writeFileSync(reg, fs.readFileSync(reg, 'utf8').replace('__PLUGIN__', plugin.replace(/\\/g, '\\\\')));
    const list = await listSlashCommands({ configDir: cfg, cwd: proj, aiosCommands: [{ name: 'today', description: 'Generate a grounded daily plan', argumentHint: '[focus]' }] });
    const by = Object.fromEntries(list.map((c) => [c.name, c]));
    assert.equal(by['compact'].source, 'builtin');
    assert.equal(by['standup'].source, 'project', 'project beats user');
    assert.equal(by['standup'].description, 'Project stand-up wins over the user one');
    assert.equal(by['deploy'].argumentHint, '[branch]');
    assert.equal(by['aios:ship'].plugin, 'aios', 'a command only the installed copy has');
    assert.equal(by['aios:today'].description, 'Generate a grounded daily plan', 'the framework\'s live copy comes before an installed plugin\'s cached one');
    assert.ok(names(list).filter((n) => n === 'aios:today').length === 1);
    assert.equal(list.length, BUILTIN_COMMANDS.length + 4, 'built-ins + standup (project, shadowing the user one) + deploy + aios:today (once) + aios:ship; compact.md is shadowed by the built-in');
    // no project folder: project commands are skipped, everything else stays
    const noProj = await listSlashCommands({ configDir: cfg, cwd: null });
    assert.equal(noProj.find((c) => c.name === 'deploy'), undefined);
    assert.equal(noProj.find((c) => c.name === 'standup')?.source, 'user');
    // a relative cwd is not trusted as a folder to read
    assert.equal((await listSlashCommands({ configDir: cfg, cwd: 'relative/dir' })).find((c) => c.name === 'deploy'), undefined);
    // the whole chain, as the popup uses it
    assert.equal(slashSuggestions(list, '/dep')[0].name, 'deploy');
    assert.equal(slashSuggestions(list, '/tod')[0].name, 'aios:today');
    // control: with nothing on disk it is just the built-ins
    const bare = tree({});
    try { assert.equal((await listSlashCommands({ configDir: bare, cwd: null })).length, BUILTIN_COMMANDS.length); } finally { fs.rmSync(bare, { recursive: true, force: true }); }
  } finally { for (const d of [cfg, plugin, proj]) fs.rmSync(d, { recursive: true, force: true }); }
});
