/**
 * Resuming several closed sessions brings them back the way a relaunch does: as tabs that resume
 * when opened, and only the first one now.
 *
 * Each `claude --resume` starts its own copy of every configured MCP server, so starting them all
 * in the same second makes the heavier local servers miss their connect window in every session.
 * A lazy tab starts nothing until it is opened, so they start one at a time, at the operator's
 * pace. These EXECUTE the real function out of renderer/app.js: what matters is which sessions
 * start, and only running the code can say that.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

const app = fs.readFileSync('renderer/app.js', 'utf8');
function grab(src: string, re: RegExp, what: string): string {
  const m = re.exec(src);
  if (!m) assert.fail(`${what} must be findable in renderer/app.js`);
  return m[0];
}

type Pick = { id: string; name: string };
type Lazy = { sessionId: string; name: string; cwd: string };

function harness(src: string, open: string[] = []) {
  const panes = new Map<string, { exited: boolean }>();
  for (const n of open) panes.set('open-' + n, { exited: false });
  const lazy: Lazy[] = [];
  const started: string[] = [];
  let persisted = 0;
  const fn = grab(src, /function resumeAsTabs\(picked\) \{[\s\S]*?\n\}/, 'resumeAsTabs');
  const run = new Function('panes', 'byName', 'createRestoreTab', 'materializeRestore', 'persistSessions', fn + '\nreturn resumeAsTabs;')(
    panes,
    (n: string) => (panes.has('open-' + n) ? ['open-' + n] : null),
    (s: Lazy) => { lazy.push(s); return 'restore-' + lazy.length; },
    (id: string) => { started.push(id); return Promise.resolve(true); },
    () => { persisted++; },
  ) as (p: Pick[]) => string[];
  return { run, lazy, started, persisted: () => persisted };
}
const pick = (...names: string[]): Pick[] => names.map((name) => ({ id: name + '-id', name }));

test('every picked session comes back as a lazy tab, and only the first starts now', () => {
  const h = harness(app);
  const ids = h.run(pick('one', 'two', 'three'));
  assert.deepEqual(h.lazy.map((s) => s.name), ['one', 'two', 'three'], 'all of them, as tabs, in the order ticked');
  assert.deepEqual(h.lazy.map((s) => s.sessionId), ['one-id', 'two-id', 'three-id'], 'each tab resumes its own transcript');
  assert.deepEqual(ids, ['restore-1', 'restore-2', 'restore-3']);
  assert.deepEqual(h.started, ['restore-1'], 'one process now: the rest start when opened, so there is no MCP storm');
  assert.equal(h.persisted(), 1, 'the tabs are remembered, so a quit keeps them');
});

test('a session already open is not reopened, and the first that is not takes the start', () => {
  const h = harness(app, ['one']);
  const ids = h.run(pick('one', 'two', 'three'));
  assert.deepEqual(h.lazy.map((s) => s.name), ['two', 'three']);
  assert.deepEqual(h.started, [ids[0]]);
  const none = harness(app, ['one']);
  assert.deepEqual(none.run(pick('one')), [], 'nothing left to open: nothing created, nothing started');
  assert.deepEqual(none.started, []);
  assert.equal(none.persisted(), 0);
});

test('NEGATIVE CONTROL: a version that starts every tab at once is caught', () => {
  const broken = app.replace('  void materializeRestore(ids[0]);', '  for (const id of ids) void materializeRestore(id);');
  assert.notEqual(broken, app, 'the control must actually change the code');
  const h = harness(broken);
  h.run(pick('one', 'two', 'three'));
  assert.notDeepEqual(h.started, ['restore-1'], 'starting all three is exactly the storm this replaces');
});

test('a lazy tab starts when it is opened: the same path a relaunch uses', () => {
  assert.match(app, /if \(p\.kind === 'restore'\) \{ void materializeRestore\(id\); return; \}/, 'opening a restore tab resumes it');
  assert.match(grab(app, /function createRestoreTab\(s\) \{[\s\S]*?\n\}/, 'createRestoreTab'), /tab\.classList\.add\('restoring'\)/, 'its name reads as not yet started');
});

test('the picker hands over to the lazy tabs and says what it did', () => {
  const body = grab(app, /async function batchResume\(\) \{[\s\S]*?\n\}/, 'batchResume');
  assert.match(body, /const ids = resumeAsTabs\(picked\);/);
  assert.match(body, /ids\.length > 1 \? t\('resume\.openedTabs', \{ n: ids\.length \}\) : t\('resume\.started', \{ n: 1 \}\)/);
  assert.doesNotMatch(body, /createPane\(\{ name: (?!'resume')/, 'no picked session is started from the picker itself (only Claude\'s own picker, the escape hatch)');
  assert.doesNotMatch(app, /function resumeInSequence\(/, 'the one-at-a-time sequence is gone');
});

test('every locale says the tabs resume when opened, with the count', () => {
  for (const loc of ['en', 'es', 'pt-br', 'el']) {
    const j = JSON.parse(fs.readFileSync(`src/i18n/locales/${loc}.json`, 'utf8')) as Record<string, string>;
    assert.ok(j['resume.openedTabs'] && j['resume.openedTabs'].includes('{n}'), `${loc} resume.openedTabs keeps {n}`);
    for (const gone of ['resume.progress', 'resume.allUp', 'resume.someUp']) assert.equal(j[gone], undefined, `${loc} ${gone} is no longer used`);
  }
});
