/**
 * A bus kill ends the session AND closes its tab, also when the session had already ended.
 *
 * When a session leaves the registry, the App keeps its tab with the shell that is left and renames
 * it "<name> (ended)". A later `kill` for that name looked for a tab called "<name>", found none,
 * closed nothing, and the bus logged "closed any pane of that name" regardless. Measured on a test
 * session: its tab stayed open after the kill.
 *
 * The renderer is a plain script, so its two functions are taken out of the file and run here
 * against a toy set of tabs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { firstChildOf } from '../main/aios';

const app = fs.readFileSync('renderer/app.js', 'utf8');
const fnSrc = (name: string): string => {
  const m = new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`).exec(app);
  assert.ok(m, `${name} must exist in renderer/app.js`);
  return m![0];
};

type Pane = { kind: string; name: string; isSession?: boolean; exited?: boolean; endedName?: string | null };
/** Build the two renderer functions over a toy world. `busy[id]` is the pid main would report running
 *  under that pane's shell (0: idle), or null when it cannot tell. */
function world(tabs: Record<number, Pane>, busy: Record<number, number | null> = {}) {
  const panes = new Map<number, Pane>(Object.entries(tabs).map(([k, v]) => [Number(k), v]));
  const closedIds: number[] = [];
  const reports: [string, number, { shell: number; child: number }[], boolean][] = [];
  const asked: number[][] = [];
  const byName = (name: string): [number, Pane] | undefined => {
    const named = [...panes.entries()].filter(([, p]) => p.kind === 'term' && p.name === name);
    return named.find(([, p]) => !p.exited) || named[0];
  };
  const ambiguous = (name: string): boolean => [...panes.values()].filter((p) => p.kind === 'term' && p.name === name && !p.exited).length > 1;
  const closePane = (id: number): void => { closedIds.push(id); panes.delete(id); };
  const window = { glassShell: {
    busCloseResult: (a: string, c: number, b: { shell: number; child: number }[], r: boolean): void => { reports.push([a, c, b, r]); },
    ptyBusy: async (ids: number[]): Promise<Record<number, { shell: number; child: number } | null>> => {
      asked.push(ids);
      return Object.fromEntries(ids.map((i) => { const c = i in busy ? busy[i] : 0; return [i, c === null ? null : { shell: 1000 + i, child: c }]; }));
    },
  } };
  const build = new Function('panes', 'byName', 'ambiguous', 'closePane', 'toast', 't', 'window',
    `${fnSrc('tabsLeftBy')}\n${fnSrc('closeTabsByName')}\nreturn { tabsLeftBy, closeTabsByName };`);
  const fns = build(panes, byName, ambiguous, closePane, () => undefined, (k: string) => k, window) as {
    tabsLeftBy(name: string): number[]; closeTabsByName(m: { name: string; id?: string }): Promise<void>;
  };
  return { panes, closedIds, reports, asked, ...fns };
}
const ended = (name: string, extra: Partial<Pane> = {}): Pane => ({ kind: 'term', name: `${name} (ended)`, isSession: false, endedName: name, ...extra });
const live = (name: string): Pane => ({ kind: 'term', name, isSession: true });

test('REGRESSION: a kill for a session that already ended closes the tab it left', async () => {
  const w = world({ 1: ended('designer'), 2: live('other') });
  await w.closeTabsByName({ name: 'designer' });
  assert.deepEqual(w.closedIds, [1], 'the "(ended)" tab is found by the session it belonged to, not by its present name');
  assert.deepEqual(w.reports, [['designer', 1, [], false]], 'and the bus is told what was closed');
  assert.equal(w.panes.has(2), true);
});

test('a live session\'s tab closes as before, with no question asked about its shell', async () => {
  const w = world({ 1: live('designer') });
  await w.closeTabsByName({ name: 'designer' });
  assert.deepEqual(w.closedIds, [1]);
  assert.deepEqual(w.asked, [], 'the session was just killed: its tab closes, as it always did');
  assert.deepEqual(w.reports, [['designer', 1, [], false]]);
});

test('THE GUARD: a left-behind tab with a command running in its shell is NOT closed, and the bus is told', async () => {
  /* Closing an idle shell is what was asked. Taking a command someone left running there is not. */
  const w = world({ 1: ended('designer') }, { 1: 4242 });
  await w.closeTabsByName({ name: 'designer' });
  assert.deepEqual(w.closedIds, [], 'something is running in that shell: it stays');
  assert.deepEqual(w.asked, [[1]], 'main was asked about that pane');
  assert.deepEqual(w.reports, [['designer', 0, [{ shell: 1001, child: 4242 }], false]], 'the bus is told which shell runs which process');
});

test('when it cannot be told whether the shell is idle, the tab stays', async () => {
  const w = world({ 1: ended('designer') }, { 1: null });
  await w.closeTabsByName({ name: 'designer' });
  assert.deepEqual(w.closedIds, []);
  assert.deepEqual(w.reports, [['designer', 0, [{ shell: 0, child: 0 }], false]], 'reported as unknown (0, 0), not as a running command');
});

test('a left-behind tab whose shell has already exited is closed without asking', async () => {
  const w = world({ 1: ended('designer', { exited: true }) });
  await w.closeTabsByName({ name: 'designer' });
  assert.deepEqual(w.closedIds, [1]);
  assert.deepEqual(w.asked, []);
});

test('CONTROL: a tab left by ANOTHER session is not closed', async () => {
  const w = world({ 1: ended('other'), 2: ended('designer-2') });
  await w.closeTabsByName({ name: 'designer' });
  assert.deepEqual(w.closedIds, []);
  assert.deepEqual(w.reports, [['designer', 0, [], false]], 'nothing of that name: reported as nothing, never as closed');
});

test('CONTROL: a tab that became a session again is not closed for the name it used to end under', async () => {
  const w = world({ 1: { kind: 'term', name: 'new-life', isSession: true, endedName: 'designer' } });
  await w.closeTabsByName({ name: 'designer' });
  assert.deepEqual(w.closedIds, []);
  assert.deepEqual(w.tabsLeftBy('designer'), []);
});

test('a live session and the tabs earlier sessions of that name left: all closed when idle', async () => {
  const w = world({ 1: live('designer'), 2: ended('designer'), 3: ended('designer') }, { 3: 77 });
  await w.closeTabsByName({ name: 'designer' });
  assert.deepEqual(w.closedIds.sort(), [1, 2]);
  assert.deepEqual(w.reports, [['designer', 2, [{ shell: 1003, child: 77 }], false]]);
});

test('two live tabs of one name: refused as before, and reported AS a refusal', async () => {
  const w = world({ 1: live('designer'), 2: live('designer') });
  await w.closeTabsByName({ name: 'designer', ask: 'k1' } as { name: string });
  assert.deepEqual(w.closedIds, []);
  assert.deepEqual(w.reports, [['k1', 0, [], true]]);
});

test('the answer carries the request\'s own token, and is sent even if a close throws', async () => {
  const w = world({ 1: ended('designer', { exited: true }) });
  await w.closeTabsByName({ name: 'designer', ask: 'close-1-7' } as { name: string });
  assert.equal(w.reports[0][0], 'close-1-7', 'two kills for one name each read their own answer');
  // a close that throws: the bus is still answered
  const panes = new Map<number, Pane>([[1, ended('x', { exited: true })]]);
  const reports: unknown[] = [];
  const build = new Function('panes', 'byName', 'ambiguous', 'closePane', 'toast', 't', 'window',
    `${fnSrc('tabsLeftBy')}\n${fnSrc('closeTabsByName')}\nreturn { closeTabsByName };`);
  const f = build(panes, () => undefined, () => false, () => { throw new Error('boom'); }, () => undefined, (k: string) => k,
    { glassShell: { busCloseResult: (...a: unknown[]) => { reports.push(a); }, ptyBusy: async () => ({}) } }) as { closeTabsByName(m: { name: string }): Promise<void> };
  await assert.rejects(f.closeTabsByName({ name: 'x' }));
  assert.equal(reports.length, 1, 'answered from the finally');
});

test('a left-behind tab is matched whatever the case of the name', async () => {
  const w = world({ 1: ended('Market-desk') });
  await w.closeTabsByName({ name: 'market-desk' });
  assert.deepEqual(w.closedIds, [1]);
});

test('the renderer records whose tab it was at the moment it renames it "(ended)"', () => {
  const i = app.indexOf('pane.endedName = was;');
  assert.ok(i > 0);
  const j = app.indexOf("renamePane(pid, t('tab.endedSession', { name: was }));", i);
  assert.ok(j > i && j - i < 600, 'set right before the rename that hides the name');
  assert.match(app, /case 'closeByName':\s*\n\s*await closeTabsByName\(m\);\s*\n\s*return;/);
});

test('firstChildOf: a shell with nothing under it is idle (0); one with children names the lowest; an unreadable table is unknown', () => {
  const table = ['  100     1   10', '  205   100   10', '  200   100   10', '  201   200   10', '  300     1   10', 'junk'].join('\n');
  assert.deepEqual(firstChildOf([100, 200, 300, 999], table), { 100: 200, 200: 201, 300: 0, 999: 0 });
  assert.deepEqual(firstChildOf([], table), {});
  assert.equal(firstChildOf([100], ''), null, 'an empty table is "could not read", never "nothing is running"');
  assert.equal(firstChildOf([100], 'garbage\nmore garbage'), null);
});

test('a tab renamed away from its "(ended)" label is no longer the one that session left', () => {
  const r = /function renamePane\(id, name\) \{[\s\S]*?\n\}/.exec(app);
  assert.ok(r);
  assert.match(r![0], /if \(p\.endedName && name !== t\('tab\.endedSession', \{ name: p\.endedName \}\)\) p\.endedName = null;/);
  const renamePane = new Function('panes', 'persistSessions', 't', 'paintRunning', `${r![0]}\nreturn renamePane;`);
  const panes = new Map<number, Record<string, unknown>>([[1, { name: 'x (ended)', endedName: 'x', tab: { querySelector: () => null } }]]);
  const t = (_k: string, o: { name: string }) => `${o.name} (ended)`;
  const rn = renamePane(panes, () => undefined, t, () => undefined) as (id: number, name: string) => void;
  rn(1, 'build');
  assert.equal(panes.get(1)!.endedName, null, 'renamed by the operator: a kill for x must not close it');
  panes.set(2, { name: 'y', endedName: 'y', tab: { querySelector: () => null } });
  rn(2, 'y (ended)');
  assert.equal(panes.get(2)!.endedName, 'y', 'the rename TO the ended label keeps it');
});

test('the busy check reads a table of its own, and an unreadable one leaves the tab', () => {
  /* Never the background Windows reading: it can be a minute old, and keeps its last table when a
     scan fails, so a command started since would read as idle. */
  const main = fs.readFileSync('src/main/main.ts', 'utf8');
  const i = main.indexOf("ipcMain.handle('pty:busy', async");
  assert.ok(i > 0, 'the handler is async');
  const h = main.slice(i, main.indexOf('\n});', i));
  assert.match(h, /const table = pidOf\.size \? await aios\.processTableNow\(\) : null;/);
  assert.match(h, /const first = table === null \? null : aios\.firstChildOf\(\[\.\.\.pidOf\.values\(\)\], table\);/);
  const aiosSrc = fs.readFileSync('src/main/aios.ts', 'utf8');
  const f = aiosSrc.slice(aiosSrc.indexOf('export function processTableNow('));
  assert.match(f.slice(0, 900), /if \(tableNowInFlight\) return tableNowInFlight;/, 'shared while one runs');
  assert.match(f.slice(0, 900), /\? await winScanOnce\(\)/, 'on Windows: a scan started for this question, never the background table');
  assert.match(f.slice(0, 900), /\} catch \{ return null; \}/, 'a failed scan is null, never an old table');
});

test('a tab renamed or adopted WHILE the shell is being checked is not closed', async () => {
  /* On Windows the check takes seconds. A tab the operator renamed meanwhile (endedName cleared) is
     somebody's now. */
  const tabs = { 1: ended('designer') };
  const panes = new Map<number, Pane>(Object.entries(tabs).map(([k, v]) => [Number(k), v]));
  const closedIds: number[] = [];
  const build = new Function('panes', 'byName', 'ambiguous', 'closePane', 'toast', 't', 'window',
    `${fnSrc('tabsLeftBy')}\n${fnSrc('closeTabsByName')}\nreturn { closeTabsByName };`);
  const f = build(panes, () => undefined, () => false, (id: number) => { closedIds.push(id); }, () => undefined, (k: string) => k,
    { glassShell: { busCloseResult: () => undefined,
      ptyBusy: async () => { panes.get(1)!.endedName = null; panes.get(1)!.name = 'build'; return { 1: { shell: 9, child: 0 } }; } } }) as { closeTabsByName(m: { name: string }): Promise<void> };
  await f.closeTabsByName({ name: 'designer' });
  assert.deepEqual(closedIds, [], 'renamed during the check: left alone, although its shell was idle');
});

test('the bus settles a kill on what the window reports, and never claims a tab it did not close', () => {
  const main = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  assert.doesNotMatch(main, /log\([^\n]*closed any pane of that name/, 'the sentence that was LOGGED whether or not a pane was found is gone (comments may still quote it)');
  assert.doesNotMatch(main, /: ' — no live session has that name or was renamed from it; closed any pane/);
  const i = main.indexOf('async function settleKill(');
  const settle = main.slice(i, main.indexOf('\n}\n', i));
  assert.match(settle, /const v = ask === undefined \? undefined : await awaitCloseVerdict\(ask\);/, 'no window open: nothing to wait for');
  assert.match(settle, /else if \(v && v\.busy\.length > 0\) \{[\s\S]{0,120}markUndelivered\(heldPath, req, `no live session is named '\$\{req\.name\}', and the terminal it left was not closed: \$\{leftLine\(v\.busy\)\}/,
    'a kill that could close nothing because the shell is in use is a dead letter with that reason');
  // the three sentences Glass uses for the same cases
  assert.match(settle, /no live session and no terminal left by one: nothing to close/);
  assert.match(settle, /no live session; closed the terminal it left/);
  assert.match(settle, /left \$\{known\.length\} open because something is running in it \(\$\{known\.map\(\(b\) => `shell \$\{b\.shell\} is running pid \$\{b\.child\}`\)/);
  assert.match(settle, /open because what is running in it could not be read/, 'unknown is said as unknown');
  assert.match(settle, /if \(!killed\) \{ markUndelivered\(heldPath, req, `no live session is named '\$\{req\.name\}', and \$\{why\}/, 'a refusal with no session to kill is a dead letter, never "done"');
  const wait = main.slice(main.indexOf('async function awaitCloseVerdict('), main.indexOf('async function awaitCloseVerdict(') + 900);
  assert.match(wait, /for \(let i = 0; i < 800; i\+\+\)/, 'long enough for a Windows scan');
  assert.match(wait, /abandonedAsks\.add\(ask\);/, 'a late answer is not stored');
  // the kill branch hands the held file to settleKill, after the guard and the signal
  const k = main.indexOf("if (req.action === 'kill') {");
  const branch = main.slice(k, main.indexOf("} else if (req.action === 'resume')", k));
  assert.ok(branch.indexOf('decideKill(') > 0 && branch.indexOf('decideKill(') < branch.indexOf("emit(w, 'closeByName'"), 'the expect guard still comes first');
  assert.match(branch, /const ask = `close-\$\{process\.pid\}-\$\{\+\+closeAsks\}`;/, 'a token per request');
  assert.match(branch, /emit\(w, 'closeByName', \{ name: t \? t\.name : req\.name, ask \}\);/);
  assert.match(branch, /void settleKill\(heldPath, req, [\s\S]{0,120}, windowOpen \? ask : undefined\);\s*\n\s*return;/);
});
