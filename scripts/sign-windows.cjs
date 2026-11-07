/**
 * Sign one Windows executable with SSL.com eSigner (an OV certificate held in SSL.com's cloud HSM).
 *
 * electron-builder calls this for EVERY file it signs: the app's own AIOS.exe, the nsis installer
 * and its uninstaller. That is why signing lives here, inside the build, and not as a step after
 * it: a file signed afterwards no longer matches the sha512 that `latest.yml` recorded, so every
 * Windows updater would reject the update, and the app inside the installer would stay unsigned
 * (Smart App Control checks each executable that runs, not only the installer).
 *
 * WITH NO CREDENTIALS IT SIGNS NOTHING AND SAYS SO. A fork, a pull request and a local
 * `npm run dist:win` have no secrets, and must keep building exactly as before. The release
 * workflow decides whether an unsigned build is acceptable; this hook only signs when it can.
 *
 * WITH CREDENTIALS IT FAILS LOUDLY. CodeSignTool has been seen to exit 0 after a failed sign, so
 * the exit code is not trusted: after signing, Windows itself is asked whether the file carries a
 * valid Authenticode signature, and anything but "Valid" stops the build.
 *
 * Credentials come from the environment, never from arguments printed in a log:
 *   ES_USERNAME, ES_PASSWORD, ES_CREDENTIAL_ID, ES_TOTP_SECRET   (SSL.com eSigner account)
 *   CODE_SIGN_TOOL_DIR                                            (unzipped CodeSignTool, pinned by the workflow)
 */
'use strict';
const path = require('node:path');
const childProcess = require('node:child_process');

/** A file's name for logs: win32 rules, which accept both separators (the hook runs on Windows). */
const name = (file) => path.win32.basename(String(file));
const REQUIRED = ['ES_USERNAME', 'ES_PASSWORD', 'ES_CREDENTIAL_ID', 'ES_TOTP_SECRET'];
const CST_JAR = path.join('jar', 'code_sign_tool-1.3.2.jar');
const CST_JAVA = path.join('jdk-11.0.2', 'bin', 'java.exe');

/** Which credentials are missing, by name (never by value). */
function missingCredentials(env) {
  return REQUIRED.filter((k) => !String(env[k] || '').trim());
}

/** The CodeSignTool command for one file: java, then arguments. Secrets go in as separate argv
 *  entries (execFile, no shell), so nothing has to be quoted and nothing is re-parsed. */
function signCommand(file, env) {
  const dir = env.CODE_SIGN_TOOL_DIR;
  return {
    cmd: path.join(dir, CST_JAVA),
    args: ['-jar', path.join(dir, CST_JAR), 'sign',
      `-username=${env.ES_USERNAME}`,
      `-password=${env.ES_PASSWORD}`,
      `-credential_id=${env.ES_CREDENTIAL_ID}`,
      `-totp_secret=${env.ES_TOTP_SECRET}`,
      `-input_file_path=${file}`,
      '-override=true'],
    cwd: dir,
  };
}

/** Ask Windows, not the signing tool, whether the file is signed: Authenticode status and signer. */
function authenticode(file, exec) {
  const ps = `$s = Get-AuthenticodeSignature -LiteralPath '${String(file).replace(/'/g, "''")}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`;
  const out = String(exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' })).trim();
  const [status, subject = ''] = out.split('|');
  return { status, subject };
}

/** The work, with its effects injected so a test can run it on any platform. */
async function signWith(configuration, deps) {
  const { env, exec, log } = deps;
  const file = configuration.path;
  const missing = missingCredentials(env);
  if (missing.length) {
    log(`sign-windows: no eSigner credentials (${missing.join(', ')} unset); ${name(file)} stays unsigned`);
    return false;
  }
  if (!String(env.CODE_SIGN_TOOL_DIR || '').trim()) throw new Error('sign-windows: credentials are set but CODE_SIGN_TOOL_DIR is not; the workflow must install CodeSignTool first');
  const c = signCommand(file, env);
  log(`sign-windows: signing ${name(file)} with eSigner`);
  try {
    exec(c.cmd, c.args, { cwd: c.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    // The message can echo the command line: report the file and the exit, never the arguments.
    throw new Error(`sign-windows: CodeSignTool failed on ${name(file)} (exit ${e && e.status})`);
  }
  const v = authenticode(file, exec);
  if (v.status !== 'Valid') throw new Error(`sign-windows: ${name(file)} is not validly signed after signing (Authenticode status: ${v.status || 'none'})`);
  log(`sign-windows: ${name(file)} signed (${v.subject})`);
  return true;
}

module.exports = async function sign(configuration) {
  return signWith(configuration, { env: process.env, exec: childProcess.execFileSync, log: (m) => console.log(m) });
};
module.exports.signWith = signWith;
module.exports.signCommand = signCommand;
module.exports.missingCredentials = missingCredentials;
