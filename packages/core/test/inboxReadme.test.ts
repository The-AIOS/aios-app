/** The spawn-inbox README: one text for both surfaces, and one rule for who writes it. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { buildInboxReadme, shouldWrite, readmeStamp, readmeBody, README_TEXT_REVISION, INBOX_CONTRACT, type ReadmeWriter } from '../src/inboxReadme';
import { TIMINGS } from '../src/sendQueue';

const APP: ReadmeWriter = { surface: 'app', version: '0.18.0' };
const GLASS: ReadmeWriter = { surface: 'glass', version: '0.6.0' };
const A = buildInboxReadme(APP);
const G = buildInboxReadme(GLASS);

test('ONE body: what the App writes and what Glass writes differ only in who wrote it', () => {
  assert.notEqual(A, G);
  assert.equal(readmeBody(A), readmeBody(G), 'the same text, whoever writes');
  const diff = A.split('\n').filter((l, i) => l !== G.split('\n')[i]);
  assert.equal(diff.length, 2, 'the writer line and the trailer, nothing else');
  assert.match(A, /^_Written by AIOS App v0\.18\.0 /m);
  assert.match(G, /^_Written by AIOS Glass v0\.6\.0 /m);
});

test('the trailer keeps the phrases other versions and the framework read', () => {
  assert.equal(readmeStamp(APP), `<!-- aios-spawn-inbox: contract ${INBOX_CONTRACT} · text ${README_TEXT_REVISION} · written by AIOS App v0.18.0 -->`);
  assert.match(readmeStamp(GLASS), /aios-spawn-inbox: contract \d+ · text \d+ · written by AIOS Glass v0\.6\.0/);
  assert.ok(A.trimEnd().endsWith(readmeStamp(APP)));
});

test('the body is pinned to its revision: change the text and the revision moves with it', () => {
  /* shouldWrite compares REVISIONS, so a changed body under an unchanged revision would never
     replace the old text on a machine where the other surface wrote it. */
  const sha = crypto.createHash('sha256').update(readmeBody(A)).digest('hex').slice(0, 16);
  assert.deepEqual({ rev: README_TEXT_REVISION, sha }, { rev: 1, sha: '849339cb586588f1' },
    'the README text changed: bump README_TEXT_REVISION and record the new digest here, together');
});

test('it documents the fields only one surface implements, whoever writes it', () => {
  /* The defect this replaces: Glass's own text won on disk and said nothing of these, so an agent
     following the file CLAUDE.md calls the authority concluded they did not exist. */
  for (const doc of [A, G]) {
    for (const field of ['`cwd`', '`addDirs`', '`group`', '"expect"', '"kill-expect"']) assert.ok(doc.includes(field), `${field} is documented`);
    for (const verb of ['spawn', 'send', 'kill', 'resume']) assert.match(doc, new RegExp(`\\*\\*${verb}\\*\\*`));
    assert.match(doc, /resolve-tier --list/);
    assert.match(doc, /\.claude\/sessions/);
  }
});

test('the timings it prints are the contract\'s own numbers', () => {
  const min = (ms: number): number => ms / 60000;
  assert.equal(min(TIMINGS.QUEUE_CEILING_MS), 24 * 60);
  assert.match(A, /QUEUE_CEILING_MS 24 h /);
  assert.equal(min(TIMINGS.HOLD_STALE_MS), 24 * 60 + 45);
  assert.match(A, /HOLD_STALE_MS {2}24 h 45m /);
  assert.equal(min(TIMINGS.MAX_HOLD_MS), 30);
  assert.match(A, /MAX_HOLD_MS {4}30 min /);
  assert.equal(min(TIMINGS.RETIRE_TTL_MS), 10);
  assert.match(A, /RETIRE_TTL_MS {2}10 min /);
  assert.match(A, new RegExp(`MAX_RELEASES {3}${TIMINGS.MAX_RELEASES} `));
  assert.match(A, new RegExp(`MAX_DELIVERY_ATTEMPTS ${TIMINGS.MAX_DELIVERY_ATTEMPTS} `));
});

test('the liveness recipe it hands to agents never probes with os.kill on Windows', () => {
  /* Python's os.kill(pid, 0) is a probe on POSIX and TerminateProcess on Windows: an agent that
     followed the old recipe there ended the surface it was asking about. */
  assert.doesNotMatch(A, /os\.kill\(d\["pid"\], 0\)/, 'no unguarded probe on the announced pid');
  const recipe = A.slice(A.indexOf('def alive(pid):'), A.indexOf('def parent(pid):'));
  assert.ok(recipe.length > 0, 'the recipe defines alive()');
  const nt = recipe.indexOf('if os.name == "nt":'), sig = recipe.indexOf('os.kill(pid, 0)');
  assert.ok(nt > 0, 'the recipe branches on Windows');
  assert.ok(sig > nt, 'and Windows is handled BEFORE the signal');
  assert.match(recipe.slice(nt, sig), /return str\(pid\) in out\.split\(\)/, 'the Windows branch returns before reaching the signal');
  assert.match(recipe, /tasklist/);
  assert.match(A, /if alive\(d\["pid"\]\):/);
});

/* ── who writes ─────────────────────────────────────────────────────────── */
const legacyGlass = (contract: number | null): string =>
  `# The AIOS spawn-inbox\n\nglass's own text\n\n${contract === null ? '_written by AIOS Glass_' : `<!-- aios-spawn-inbox: contract ${contract} · written by AIOS Glass v0.5.17 -->`}\n`;
const legacyApp = (contract: number): string => `# The AIOS spawn-inbox\n\nthe app's old text\n\n<!-- aios-spawn-inbox: contract ${contract} · written by AIOS App -->\n`;
const withRev = (doc: string, rev: number): string => doc.replace(`· text ${README_TEXT_REVISION} ·`, `· text ${rev} ·`);

test('writes when there is nothing, or nothing but whitespace', () => {
  for (const w of [APP, GLASS]) {
    assert.equal(shouldWrite(undefined, A, w), true);
    assert.equal(shouldWrite('  \n', A, w), true);
  }
});

test('never downgrades a newer contract, always replaces an older one, whoever wrote it', () => {
  for (const w of [APP, GLASS]) {
    assert.equal(shouldWrite(legacyGlass(INBOX_CONTRACT + 1), A, w), false);
    assert.equal(shouldWrite(legacyApp(INBOX_CONTRACT + 1), A, w), false);
    assert.equal(shouldWrite(legacyGlass(INBOX_CONTRACT - 1), A, w), true);
    assert.equal(shouldWrite(legacyApp(INBOX_CONTRACT - 1), A, w), true);
  }
});

test('same contract, same text revision: two surfaces never trade the file', () => {
  assert.equal(shouldWrite(G, A, APP), false, 'Glass wrote the shared text: the App leaves it');
  assert.equal(shouldWrite(A, G, GLASS), false, 'the App wrote it: Glass leaves it');
  assert.equal(shouldWrite(A, A, APP), false, 'our own, unchanged: no churn on every start');
});

test('our own doc is refreshed when it moved (a new version of this surface)', () => {
  const older = buildInboxReadme({ surface: 'app', version: '0.17.0' });
  assert.equal(shouldWrite(older, A, APP), true, 'the version line changed');
  assert.equal(shouldWrite(older, G, GLASS), false, 'but that is not Glass\'s to rewrite');
});

test('a newer text revision is left alone, an older one is replaced, whoever wrote either', () => {
  for (const w of [APP, GLASS]) {
    assert.equal(shouldWrite(withRev(A, README_TEXT_REVISION + 1), A, w), false, 'theirs is ahead');
    assert.equal(shouldWrite(withRev(G, README_TEXT_REVISION + 1), A, w), false);
  }
  if (README_TEXT_REVISION > 1) {
    for (const w of [APP, GLASS]) assert.equal(shouldWrite(withRev(G, README_TEXT_REVISION - 1), A, w), true);
  }
  assert.equal(shouldWrite(withRev(A, 0), A, GLASS), true, 'an older shared text is replaced by either surface');
});

test('a surface that still carries its own text, at the same contract', () => {
  /* A Glass that has not adopted the shared text rewrites the file whenever it differs from its
     own. Writing over its doc would flip the file on every launch of either surface, so the App
     leaves it, as it always did. Each surface replaces ITS OWN older doc. */
  assert.equal(shouldWrite(legacyGlass(INBOX_CONTRACT), A, APP), false, 'the App does not start a flicker with an old Glass');
  assert.equal(shouldWrite(legacyGlass(INBOX_CONTRACT), G, GLASS), true, 'the new Glass replaces the old Glass\'s text');
  assert.equal(shouldWrite(legacyApp(INBOX_CONTRACT), A, APP), true, 'the new App replaces the old App\'s text');
  assert.equal(shouldWrite(legacyApp(INBOX_CONTRACT), G, GLASS), false, 'and Glass leaves an old App\'s doc to the App');
});

test('a doc with no contract stamp, or one nobody recognises, is never clobbered', () => {
  for (const w of [APP, GLASS]) {
    assert.equal(shouldWrite(legacyGlass(null), A, w), false, 'a Glass from before stamps');
    assert.equal(shouldWrite('# my notes about the inbox\n', A, w), false, 'hand-written');
    assert.equal(shouldWrite(`x\n<!-- aios-spawn-inbox: contract ${INBOX_CONTRACT} · written by something else -->\n`, A, w), false);
    assert.equal(shouldWrite(`x\n<!-- aios-spawn-inbox: contract ${INBOX_CONTRACT} · text 0 · written by someone -->\n`, A, w), false, 'an older revision, but not by a surface we know');
    assert.equal(shouldWrite(`x\n<!-- aios-spawn-inbox: contract ${INBOX_CONTRACT - 1} · written by someone -->\n`, A, w), false, 'nor an older contract');
  }
});

test('the contract is read independently of the separator', () => {
  const newer = `doc\n<!--aios-spawn-inbox: contract   ${INBOX_CONTRACT + 1}|written by AIOS Glass-->`;
  assert.equal(shouldWrite(newer, A, APP), false, 'a newer contract, in a layout we do not write');
  const older = `doc\n<!--aios-spawn-inbox: contract   ${INBOX_CONTRACT - 1}|written by AIOS Glass-->`;
  assert.equal(shouldWrite(older, A, APP), true, 'and an older one: the number was read, not the layout');
});

test('the rule reads the TRAILER, not the body: a doc that quotes the mark or a writer in its text decides nothing', () => {
  /* The README itself tells agents to look for `aios-spawn-inbox: contract N`, so the body may
     quote it, with any number, and may name either surface. */
  const quoting = `# doc\n\nlook for \`aios-spawn-inbox: contract 99 · text 99\` written by AIOS Glass\n\n${readmeStamp(APP)}\n`;
  assert.equal(shouldWrite(quoting, A, APP), true, 'ours, same contract and revision, body differs: refreshed, not mistaken for contract 99');
  assert.equal(shouldWrite(quoting, G, GLASS), false, 'and not mistaken for Glass\'s own');
});

test('the pin covers the writer line and the trailer too, all but the name and the version', () => {
  assert.equal(readmeBody(A), readmeBody(buildInboxReadme({ surface: 'app', version: '9.9.9' })));
  assert.match(readmeBody(A), /^_Written by <writer> when it started\. \*\*Do not edit\*\*/m);
  assert.match(readmeBody(A), /aios-spawn-inbox: contract \d+ · text \d+ · written by <writer> -->$/);
  assert.notEqual(readmeBody(A), readmeBody(A.replace('**Do not edit**', '**Edit freely**')), 'a change to the rest of that line moves the digest');
});
