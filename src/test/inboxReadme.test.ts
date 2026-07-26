/**
 * Spawn-inbox README tests — the write policy, which is where this can silently
 * do the wrong thing: clobber Glass's doc (two writers fighting forever) or
 * overwrite something the operator hand-edited. Also guards that the doc keeps
 * teaching all three verbs, since a doc that drifts from the handler is worse
 * than no doc.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { buildInboxReadme, shouldWrite, readmeStamp, INBOX_CONTRACT } from '../core/inboxReadme';

const OURS = buildInboxReadme('0.2.0');

test('writes when absent — the app-only operator, no IDE and no Glass', () => {
  assert.equal(shouldWrite(undefined, OURS), true);
  assert.equal(shouldWrite('', OURS), true);
  assert.equal(shouldWrite('   \n  ', OURS), true);
});

test('defers to a Glass doc at the same contract — the verbs are identical, and both sides only write on a real diff', () => {
  const glass = `# The AIOS spawn-inbox — the command bus\n\n_Written by AIOS Glass v0.4.5 on activation._\n\n<!-- aios-spawn-inbox: contract ${INBOX_CONTRACT} · written by AIOS Glass v0.4.5 -->\n`;
  assert.equal(shouldWrite(glass, OURS), false);
});

test('defers to a Glass doc at a NEWER contract — theirs is ahead, not stale', () => {
  const ahead = `_Written by AIOS Glass v9.9.9 on activation._\n<!-- aios-spawn-inbox: contract ${INBOX_CONTRACT + 1} · written by AIOS Glass v9.9.9 -->`;
  assert.equal(shouldWrite(ahead, OURS), false);
});

test('REPLACES a Glass doc at an older contract — a stale doc must not pass as current', () => {
  const stale = `_Written by AIOS Glass v0.4.5 on activation._\n<!-- aios-spawn-inbox: contract ${INBOX_CONTRACT - 1} · written by AIOS Glass v0.4.5 -->`;
  assert.equal(shouldWrite(stale, OURS), true);
});

test('defers to a pre-0.4.5 Glass doc that stamped no contract — clobbering it would flicker launch-for-launch', () => {
  assert.equal(shouldWrite('_Written by AIOS Glass v0.4.4 on activation._', OURS), false);
  assert.equal(shouldWrite('_written by aios glass v0.4.3 on activation._', OURS), false);
});

test('contract is read independently of the separator, so a layout change on either side cannot break interop', () => {
  const oddSep = `_Written by AIOS Glass v9._\n<!-- aios-spawn-inbox: contract ${INBOX_CONTRACT - 1} | written by AIOS Glass v9 -->`;
  assert.equal(shouldWrite(oddSep, OURS), true, 'still parsed as an older contract');
});

test('never clobbers an unknown or hand-edited doc', () => {
  assert.equal(shouldWrite('# my own notes about this folder\n', OURS), false);
  assert.equal(shouldWrite('<!-- written by some-other-tool -->', OURS), false);
});

test('idempotent on our own current doc — no rewrite churn on every start', () => {
  assert.equal(shouldWrite(OURS, OURS), false);
  assert.equal(shouldWrite(`\n${OURS}\n`, OURS), false); // trailing-whitespace tolerant
});

test('rewrites our own doc when the body changed (an upgrade must propagate)', () => {
  const stale = OURS.replace('**spawn**', '**spawnnn**');
  assert.equal(shouldWrite(stale, OURS), true);
});

test('rewrites our own doc when the contract moved on', () => {
  const older = `# old doc\n\n${readmeStamp(INBOX_CONTRACT - 1)}\n`;
  assert.equal(shouldWrite(older, OURS), true);
});

test('doc teaches every verb the dispatcher implements, and no verb it does not', () => {
  for (const verb of ['spawn', 'send', 'kill']) {
    assert.match(OURS, new RegExp(`\\*\\*${verb}\\*\\*`), `README must document '${verb}'`);
  }
  // fields the handler actually honours
  for (const field of ['"name"', '"task"', '"prompt"', '"model"', '"tier"']) {
    assert.ok(OURS.includes(field), `README must show ${field}`);
  }
  assert.match(OURS, /0\.2\.0/, 'stamps the running app version');
  assert.ok(OURS.includes(readmeStamp()), 'carries the machine-readable stamp for self-recognition');
});

test('doc states the facts that cost real bugs — registry truth, one-line prompt, consumed≠succeeded, dual-surface race', () => {
  assert.match(OURS, /\.claude\/sessions/, 'registry is the addressing truth');
  assert.match(OURS, /pgrep/, 'warns off pgrep');
  assert.match(OURS, /one line/i, 'one-line prompt rule');
  assert.match(OURS, /transcript/i, 'verify via transcript, not file disappearance');
  assert.match(OURS, /race/i, 'App+Glass both running race per request');
  // the bootstrap is App behaviour: Glass leaves a task-less spawn sitting at the
  // prompt, so a co-installed agent must not read it as universal
  assert.match(OURS, /when the App fulfils the request/, 'bootstrap claim stays App-labelled');
  assert.match(OURS, /drained/i, 'durable inbox: requests survive a closed app');
});

test('main-side writer defers, is non-fatal, and cannot feed the watcher', () => {
  const src = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  assert.match(src, /ensureReadme\(dir, appVersion\)/, 'README written at bus init, beside the mkdir');
  assert.match(src, /if \(!shouldWrite\(existing, ours\)\) return;/, 'honours the policy instead of writing blind');
  assert.match(src, /README not written/, 'a failed write must not take the bus down');
  // the watcher only treats *.json as a request, so a README can never be dispatched
  assert.match(src, /endsWith\('\.json'\)/);
});
