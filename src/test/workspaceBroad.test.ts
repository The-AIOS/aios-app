/**
 * A team member's App ran at 30–70% CPU at idle, with typing lag and frozen frames. The cause was
 * `/` in .glass/shell.json as a workspace folder: every workspace folder gets a recursive fs.watch,
 * so the main process received every file event on the machine. Removing it dropped the App to ~1%
 * (reported 2026-09-23). The same list also decides what the viewer may read, so `/` opened the
 * whole disk.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as aios from '../main/aios';

const HOME_MAC = '/Users/dolores';

test('too broad: the disk, home, anything above home, a volume — on macOS', () => {
  const b = (p: string) => aios.tooBroadFolder(p, HOME_MAC, 'darwin');
  assert.equal(b('/'), 'root');
  assert.equal(b('/System/Volumes/Data'), 'root', 'macOS data volume = the whole disk');
  assert.equal(b(HOME_MAC), 'home');
  assert.equal(b(HOME_MAC + '/'), 'home', 'a trailing slash is the same folder');
  assert.equal(b('/users/DOLORES'), 'home', 'APFS is case-insensitive by default');
  assert.equal(b('/Users'), 'aboveHome');
  assert.equal(b('/Volumes/Backup'), 'volume');
});

test('a project folder is fine, including one inside home or on a volume', () => {
  const b = (p: string) => aios.tooBroadFolder(p, HOME_MAC, 'darwin');
  for (const ok of [HOME_MAC + '/code/app', HOME_MAC + '/Desktop', '/Volumes/Backup/projects', '/opt/work', '/Users/other'])
    assert.equal(b(ok), null, ok);
});

test('Linux and Windows get the same rule', () => {
  assert.equal(aios.tooBroadFolder('/', '/home/ana', 'linux'), 'root');
  assert.equal(aios.tooBroadFolder('/home', '/home/ana', 'linux'), 'aboveHome');
  assert.equal(aios.tooBroadFolder('/home/ana', '/home/ana', 'linux'), 'home');
  assert.equal(aios.tooBroadFolder('/home/ana/src', '/home/ana', 'linux'), null);
  assert.equal(aios.tooBroadFolder('C:\\', 'C:\\Users\\ana', 'win32'), 'root');
  assert.equal(aios.tooBroadFolder('c:\\users', 'C:\\Users\\ana', 'win32'), 'aboveHome');
  assert.equal(aios.tooBroadFolder('C:\\Users\\ana\\proj', 'C:\\Users\\ana', 'win32'), null);
});

function withFramework(folders: string[], fn: (cfg: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-ws-'));
  fs.mkdirSync(path.join(root, '.glass'));
  const cfg = path.join(root, '.glass', 'shell.json');
  fs.writeFileSync(cfg, JSON.stringify({ theme: 'dark', workspaceFolders: folders }));
  const saved = process.env.GLASS_FRAMEWORK_PATH;
  process.env.GLASS_FRAMEWORK_PATH = root;
  try { fn(cfg); } finally {
    if (saved === undefined) delete process.env.GLASS_FRAMEWORK_PATH; else process.env.GLASS_FRAMEWORK_PATH = saved;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const stored = (cfg: string) => JSON.parse(fs.readFileSync(cfg, 'utf8')).workspaceFolders as string[];

test('adding / is refused and nothing is written; a real folder is added', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-proj-'));
  try {
    withFramework([], (cfg) => {
      assert.equal(aios.addWorkspaceFolder('/'), 'root');
      assert.equal(aios.addWorkspaceFolder(os.homedir()), 'home');
      assert.deepEqual(stored(cfg), [], 'a refusal writes nothing');
      assert.equal(aios.addWorkspaceFolder(proj), null);
      assert.deepEqual(stored(cfg), [proj]);
    });
  } finally { fs.rmSync(proj, { recursive: true, force: true }); }
});

test('a config that ALREADY has / is protected before any cleanup, then cleaned once', () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-proj-'));
  try {
    withFramework(['/', proj, os.homedir()], (cfg) => {
      assert.deepEqual(aios.workspaceFolders(), [proj], 'never watched or readable, even before the prune');
      assert.deepEqual(aios.pruneBroadWorkspaceFolders(), ['/', os.homedir()], 'the operator is told exactly what left');
      assert.deepEqual(stored(cfg), [proj], 'only the broad entries are removed');
      assert.equal(JSON.parse(fs.readFileSync(cfg, 'utf8')).theme, 'dark', 'other settings untouched');
      assert.deepEqual(aios.pruneBroadWorkspaceFolders(), [], 'second run: nothing to say');
    });
  } finally { fs.rmSync(proj, { recursive: true, force: true }); }
});
