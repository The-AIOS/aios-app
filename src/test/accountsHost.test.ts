/**
 * The account menu's main-process half, against a stand-in framework. What matters here is what
 * it refuses to do: an older script reads an unknown flag as an email to switch to, so
 * `--availability` must never reach one, and a failing list must not read as "no accounts".
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as aios from '../main/aios';

const ROWS = JSON.stringify([
  { email: 'a@example.com', alias: 'work', state: 'active', detail: 'renews Thu', rotation: true },
  { email: 'b@example.com', alias: '', state: 'expired', detail: 'needs a new login', rotation: true },
  { email: 'c@example.com', alias: '', state: 'available', detail: 'renews Fri', rotation: true },
]);

function framework(opts: { newScript: boolean; script: string; userMd?: string }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'accounts-host-'));
  const dir = path.join(root, 'hooks', 'claude-identity');
  fs.mkdirSync(dir, { recursive: true });
  const calls = path.join(root, 'calls');
  fs.writeFileSync(path.join(dir, 'claude-identity.sh'), `#!/bin/sh\necho "$*" >> "${calls}"\n${opts.script}\n`, { mode: 0o755 });
  if (opts.newScript) fs.writeFileSync(path.join(dir, '_accounts.py'), '');
  if (opts.userMd) fs.writeFileSync(path.join(root, 'USER.md'), opts.userMd);
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(root, 'claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@example.com' } }));
  process.env.GLASS_FRAMEWORK_PATH = root;
  process.env.GLASS_CLAUDE_HOME = home;
  process.env.GLASS_CLAUDE_JSON = path.join(root, 'claude.json');
  return { calls: () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '') };
}

test('a current framework: the script answers, and says who can be picked', async () => {
  framework({ newScript: true, script: `printf '%s' '${ROWS}'` });
  const { accounts, error } = await aios.anthropicAccounts();
  assert.equal(error, '');
  assert.deepEqual(accounts.map((a) => [a.email, a.state, a.current, a.canSwitch]), [
    ['a@example.com', 'active', true, false],
    ['b@example.com', 'expired', false, false],
    ['c@example.com', 'available', false, true],
  ]);
  assert.equal(accounts[0].label, 'work (a@example.com)');
});

test('an older framework: --availability never reaches its script', async () => {
  const fw = framework({
    newScript: false, script: 'exit 0',
    userMd: '## Anthropic accounts\n\n1. `a@example.com`\n2. `b@example.com`\n',
  });
  const { accounts, error } = await aios.anthropicAccounts();
  assert.equal(error, '');
  assert.deepEqual(accounts.map((a) => a.email), ['a@example.com', 'b@example.com']);
  assert.equal(fw.calls(), '', 'it would read the flag as an email and capture the seat');
});

test('a failing list is an error with its reason, not "no accounts", and not USER.md', async () => {
  framework({
    newScript: true, script: 'echo "accounts.json is invalid" >&2; exit 2',
    userMd: '## Anthropic accounts\n\n1. `old@example.com`\n',
  });
  const { accounts, error } = await aios.anthropicAccounts();
  assert.deepEqual(accounts, []);
  assert.match(error, /invalid/);
});

test('an answer that is not the expected shape is an error too', async () => {
  framework({ newScript: true, script: 'echo not json' });
  const { error } = await aios.anthropicAccounts();
  assert.notEqual(error, '');
});

test('the swap refuses an unlisted address and an expired account before touching the seat', async () => {
  const fw = framework({ newScript: true, script: `case "$2" in --availability) printf '%s' '${ROWS}';; esac` });
  assert.equal((await aios.swapAccount('x@example.com')).ok, false);
  const expired = await aios.swapAccount('b@example.com');
  assert.equal(expired.ok, false);
  assert.match(expired.message, /new login/);
  assert.equal((await aios.swapAccount('not an email')).ok, false);
  assert.doesNotMatch(fw.calls(), /switch [a-z]@/);
  assert.equal((await aios.swapAccount('c@example.com')).ok, true);
  assert.match(fw.calls(), /switch c@example\.com/);
});

test('every call goes through the resolver: the bare word can be WSL\'s on Windows', () => {
  const src = fs.readFileSync('src/main/aios.ts', 'utf8');
  const fn = src.slice(src.indexOf('function runIdentity('), src.indexOf('export async function anthropicAccounts'));
  assert.match(fn, /const bash = resolveBash\(\)/);
  assert.match(fn, /execFile\(bash, /);
  assert.match(fn, /windowsHide: true/);
});
