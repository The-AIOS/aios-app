/**
 * Windows code signing (issue #42): SSL.com eSigner through electron-builder's signer hook.
 *
 * The hook runs on a Windows runner only, with real secrets, so its behaviour is tested here with
 * its effects injected: what it does with no credentials (signs nothing, says so), what it runs
 * with them, and that it fails closed on every path where a release could ship unsigned or leak a
 * secret into a log.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const signer = require(path.resolve('scripts/sign-windows.cjs')) as {
  signWith: (c: { path: string }, d: { env: Record<string, string>; exec: (cmd: string, args: string[], o?: unknown) => string; log: (m: string) => void }) => Promise<boolean>;
  missingCredentials: (env: Record<string, string>) => string[];
};
const creds = { ES_USERNAME: 'ops@example.com', ES_PASSWORD: 'hunter2-secret', ES_CREDENTIAL_ID: 'cred-123', ES_TOTP_SECRET: 'totp-secret-xyz', CODE_SIGN_TOOL_DIR: 'C:\\t\\cst' };
const run = (env: Record<string, string>, authStatus = 'Valid', failSign = false) => {
  const calls: Array<{ cmd: string; args: string[] }> = []; const logs: string[] = [];
  const exec = (cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    if (cmd === 'powershell.exe') return `${authStatus}|CN=Pulsar Labs, O=Pulsar Labs`;
    if (failSign) { const e = new Error(`java ${args.join(' ')} failed`) as Error & { status: number }; e.status = 1; throw e; }
    return '';
  };
  return { calls, logs, go: () => signer.signWith({ path: 'D:\\a\\dist\\AIOS-x64.exe' }, { env, exec, log: (m) => logs.push(m) }) };
};

test('with no eSigner credentials nothing is signed, nothing is run, and the log says which are missing (forks, PRs, local builds)', async () => {
  const r = run({});
  assert.equal(await r.go(), false);
  assert.equal(r.calls.length, 0);
  assert.match(r.logs[0], /ES_USERNAME, ES_PASSWORD, ES_CREDENTIAL_ID, ES_TOTP_SECRET unset/);
  assert.deepEqual(signer.missingCredentials({ ...creds, ES_TOTP_SECRET: ' ' }), ['ES_TOTP_SECRET'], 'a blank secret counts as missing');
});

test('with credentials it runs CodeSignTool once per file, with no shell, then asks Windows whether the file is signed', async () => {
  const r = run(creds);
  assert.equal(await r.go(), true);
  assert.equal(r.calls.length, 2);
  const [sign, verify] = r.calls;
  assert.match(sign.cmd, /cst[\\/]jdk-11\.0\.2[\\/]bin[\\/]java\.exe$/, 'the JDK bundled with the pinned CodeSignTool');
  assert.deepEqual(sign.args.slice(0, 3).map((a) => a.replace(/\\/g, '/')), ['-jar', 'C:/t/cst/jar/code_sign_tool-1.3.2.jar', 'sign']);
  assert.ok(sign.args.includes('-input_file_path=D:\\a\\dist\\AIOS-x64.exe'));
  assert.ok(sign.args.includes('-override=true'), 'signed in place, so electron-builder hashes the signed file');
  assert.equal(verify.cmd, 'powershell.exe');
  assert.match(verify.args.join(' '), /Get-AuthenticodeSignature -LiteralPath 'D:\\a\\dist\\AIOS-x64\.exe'/);
  assert.ok(!r.logs.join('\n').includes('hunter2-secret'), 'no secret in the log');
});

test('it fails closed: a file Windows does not call Valid stops the build, even when CodeSignTool exited 0', async () => {
  await assert.rejects(run(creds, 'NotSigned').go(), /not validly signed after signing \(Authenticode status: NotSigned\)/);
  await assert.rejects(run({ ...creds, CODE_SIGN_TOOL_DIR: '' }).go(), /CODE_SIGN_TOOL_DIR is not/, 'credentials without the tool is a broken workflow, not an unsigned build');
});

test('a failed sign names the file and the exit code, never the command line that carries the secrets', async () => {
  const err = await run(creds, 'Valid', true).go().then(() => null, (e: Error) => e);
  assert.ok(err);
  assert.match(err!.message, /CodeSignTool failed on AIOS-x64\.exe \(exit 1\)/);
  for (const secret of ['hunter2-secret', 'totp-secret-xyz', 'cred-123']) assert.ok(!err!.message.includes(secret), `the error never carries ${secret}`);
});

test('electron-builder signs through the hook, sha256 only (one call per file), and the hook is not shipped in the app', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  assert.deepEqual(pkg.build.win.signtoolOptions, { sign: './scripts/sign-windows.cjs', signingHashAlgorithms: ['sha256'] });
  assert.ok(!pkg.build.files.some((f: string) => /^scripts\/(\*\*|sign)/.test(f)), 'only scripts/setup ships');
  assert.equal(pkg.build.win.publisherName, undefined, 'no publisherName until every release is signed: electron-updater would reject an unsigned update');
});

test('the Windows release lane installs a PINNED CodeSignTool, signs inside the build, and verifies the publisher before attaching', () => {
  const wf = fs.readFileSync('.github/workflows/release-windows.yml', 'utf8');
  assert.match(wf, /ESIGNER: \$\{\{ secrets\.ES_USERNAME != '' && 'yes' \|\| 'no' \}\}/);
  assert.match(wf, /CodeSignTool\/releases\/download\/v1\.3\.2\/CodeSignTool-v1\.3\.2-windows\.zip/);
  assert.match(wf, /\$want = '4AFC32E8B7F79BBE1DE7E4E7049AAAD4E0F754357613B9BBEC0E3052F06FD36B'/, 'pinned by checksum, not only by version');
  const build = wf.slice(wf.indexOf('- name: Build nsis installer'), wf.indexOf('- name: Verify the Windows signatures'));
  for (const k of ['ES_USERNAME', 'ES_PASSWORD', 'ES_CREDENTIAL_ID', 'ES_TOTP_SECRET']) assert.match(build, new RegExp(`${k}: \\$\\{\\{ secrets\\.${k} \\}\\}`));
  const verify = wf.slice(wf.indexOf('- name: Verify the Windows signatures'), wf.indexOf('- name: Say plainly'));
  assert.match(verify, /dist\\win-unpacked\\AIOS\.exe/, 'the app inside, not only the installer');
  assert.match(verify, /-notmatch 'Pulsar Labs'/, 'and the publisher is ours');
  assert.ok(wf.indexOf('Verify the Windows signatures') < wf.indexOf('Attach the Windows artifacts'), 'verified before anything is attached');
});

test('the x64 installer ships no arm64 binaries: each signed file costs one of the plan\'s yearly signings', () => {
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const files: string[] = pkg.build.win.files || [];
  assert.ok(files.includes('!**/node_modules/node-pty/prebuilds/win32-arm64/**'), 'node-pty\'s arm64 prebuilds stay out');
  assert.ok(files.includes('!**/node_modules/node-pty/third_party/conpty/*/win10-arm64/**'), 'and the arm64 OpenConsole');
  assert.ok(!files.some((f) => /x64/.test(f)), 'never an x64 copy: those are the ones that run');
  const wf = fs.readFileSync('.github/workflows/release-windows.yml', 'utf8');
  assert.match(wf, /- name: No arm64 binaries in the x64 package/, 'and the lane checks the packaged tree');
});

test('every Windows release first upgrades over the last published release, the way the updater does, before anything is attached', () => {
  const wf = fs.readFileSync('.github/workflows/release-windows.yml', 'utf8');
  const step = wf.slice(wf.indexOf('- name: Upgrade over the last published release'), wf.indexOf('- name: No arm64 binaries'));
  assert.match(step, /gh release view --repo \$env:GITHUB_REPOSITORY --json tagName/, 'the last PUBLISHED release, which is what users have installed');
  assert.match(step, /-ArgumentList '\/S','--updated'/, 'silent, flagged as an update, as electron-updater runs it');
  assert.match(step, /after the upgrade the installed app is/, 'the installed version must be this build');
  assert.match(step, /the upgraded app is not validly signed by Pulsar Labs/, 'and signed, when this build is');
  assert.ok(wf.indexOf('Upgrade over the last published release') < wf.indexOf('Attach the Windows artifacts'), 'proven before anything reaches the release');
});
