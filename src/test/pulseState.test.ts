/**
 * Every IPC handler that mutates state the pulse DISPLAYS must re-post that state.
 *
 * THE BUG THIS EXISTS FOR (AI-153, operator-reported 2026-09-13). Home's "Frequent tasks"
 * count is a *pushed snapshot*: the renderer draws whatever the last `postState()` said, and
 * `postState()` fires only from a file watcher or an explicit `recheck`. Creating a frequent
 * task wrote `.glass/state.json` correctly and the counter did not move — the data was never
 * lost, only the display was stale, which is why quitting and reopening "fixed" it.
 *
 * The asymmetry was one line. `starter:apply` calls `host?.postState()` carrying the comment
 * "Home's frequent count changes immediately", four lines from `aios:addFrequent` and
 * `aios:removeFrequent`, which had the identical need and did not. Someone hit this once,
 * fixed it where they hit it, and the fix never generalised. That is the shape this guard is
 * built against: not a bug, a CLASS of bug that re-enters every time a handler is added.
 *
 * WHY THIS DERIVES ITS UNIVERSE INSTEAD OF LISTING IT. A hardcoded list of handlers-that-must-
 * push cannot fail for the next handler, because the next handler is not in it. That exact
 * failure already shipped here once: `LADDER_TOOLS` in doctor.test.ts was a hardcoded list, a
 * new tool joined the ladder, the list did not, and every ladder test silently stopped covering
 * it while still reporting green. So the universe is DERIVED (every handler calling an exported
 * mutator) and the exceptions are ENUMERATED. A new mutating handler lands with no verdict and
 * fails this test until someone either pushes or writes down why it needn't.
 *
 * Exemption is never automatic. Pairing mutators to getters by name looks like it would work
 * and quietly does not: `applyStarterPack` shares no stem with `frequentTaskCount`, so a
 * name-pairing rule would have EXEMPTED the one handler whose comment documents this very bug.
 * Wrong in the exempt direction is silent, so every exemption here is a written human verdict.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '..', '..', 'src', 'main');
const read = (f: string): string => fs.readFileSync(path.join(SRC, f), 'utf8');

/** Exported mutators of the aios module — the verbs that write operator-visible state. */
function mutators(aios: string): string[] {
  return [...aios.matchAll(/^export function ((?:set|add|remove|apply|clear|delete|toggle)[A-Za-z0-9_]*)/gm)]
    .map((m) => m[1]).sort();
}

/** Balanced-paren extraction of every `ipcMain.handle('channel', …)` call in main.ts. */
function handlers(main: string): { channel: string; line: number; body: string }[] {
  const out: { channel: string; line: number; body: string }[] = [];
  for (const m of main.matchAll(/ipcMain\.handle\(\s*'([^']+)'/g)) {
    const open = main.indexOf('(', m.index! + 'ipcMain.handle'.length - 1);
    let depth = 0, p = open;
    while (p < main.length) {
      if (main[p] === '(') depth++;
      else if (main[p] === ')' && --depth === 0) break;
      p++;
    }
    out.push({
      channel: m[1],
      line: main.slice(0, m.index!).split('\n').length,
      body: main.slice(m.index!, p + 1),
    });
  }
  return out;
}

/** The getters `postState()` actually calls — i.e. everything the pulse displays. */
function postStateReads(host: string): string[] {
  const i = host.indexOf('postState(): void {');
  assert.notEqual(i, -1, 'postState() not found in panelHost.ts — this guard cannot run blind');
  let depth = 0, p = i + 'postState(): void '.length;
  const start = p;
  while (p < host.length) {
    if (host[p] === '{') depth++;
    else if (host[p] === '}' && --depth === 0) break;
    p++;
  }
  return [...new Set([...host.slice(start, p + 1).matchAll(/aios\.([A-Za-z0-9_]+)\(/g)].map((m) => m[1]))].sort();
}

/**
 * Handlers that mutate something and legitimately need no push. Each reason is a MEASURED
 * claim about this code, not a category — the whole point is that it took a human read.
 */
const NO_PUSH: Readonly<Record<string, string>> = {
  'fs:addFolder':
    'workspace folders are the file tree, which is not on the postState payload; the renderer repaints the tree itself',
  'fs:addFolderPath': 'same as fs:addFolder',
  'fs:removeFolder': 'same as fs:addFolder',
  'fs:setSort': 'a sort preference for the file tree; no postState getter reads it',
  'fs:setMasterSort': 'same as fs:setSort',
  'notes:add': 'session notes render from the session registry, not from the postState payload',
  'notes:del': 'same as notes:add',
  'shell:setAutoUpdates':
    'writes ~/aios/USER.md, which panelHost WATCHES — the watcher re-posts within 250ms, so an explicit push would be the second of two',
  'claude:set':
    'model / mode / remoteControl ride postRunning (every 2s), not postState; autoUpdates lands in the watched USER.md',

  /* ── Exposed, and deliberately not fixed here. ──────────────────────────────────────────
     Both mutate state that IS on the payload, and both are unreachable: exposed on
     preload.ts (126, 138) with ZERO callers in renderer/app.js. They are recorded rather
     than patched because an unreachable handler is precisely the one whose staleness ships
     silently the day someone wires a control to it — and this map is what that person reads. */
  'shell:setPrimary':
    'EXPOSED: mutates `primary`, which IS on the payload. Latent only — preload.ts:138 has no renderer caller. Add postState() the moment a control is wired to it.',
  'shell:setFrameworkPath':
    'EXPOSED: rebases frameworkRoot(), the base for framework/agents/skills/commands/declared/observed/projects/inbox/learnings. Latent only — preload.ts:126 has no renderer caller. Add postState() (and re-arm the watchers) the moment a control is wired to it.',
};

/**
 * The payload as it stood when every exemption above was written. Pinned on purpose: widening
 * what the pulse DISPLAYS can invalidate an exemption that was correct when reasoned about,
 * and nothing else would ever say so. Adding a getter to postState() fails this test, which is
 * the prompt to re-read the map above rather than a chore.
 */
const DISPLAYED = [
  'countAgentSuggestions',
  'countNotes',
  'discoverAgents',
  'discoverCommands',
  'discoverSkills',
  'frequentTaskCount',
  'listRunningAgents',
  'nudgeState',
  'operatorName',
  'primaryName',
  'readCollabSpaces',
  'readCompanies',
  'readFrameworkStatus',
  'recentLearnings',
  'recentOutputs',
  'recentReports',
  'shellSettings',
];

test('every state-mutating IPC handler either posts state or is exempted with a reason', () => {
  const main = read('main.ts');
  const muts = mutators(read('aios.ts'));
  assert.ok(muts.length > 5, `derived only ${muts.length} mutators — the extractor is broken, not the code`);

  const offenders: string[] = [];
  let universe = 0;
  for (const h of handlers(main)) {
    const calls = muts.filter((mu) => new RegExp(`\\baios\\.${mu}\\s*\\(`).test(h.body));
    if (!calls.length) continue;
    universe++;
    if (h.body.includes('postState')) continue;
    if (h.channel in NO_PUSH) continue;
    offenders.push(`${h.channel} (main.ts:${h.line}) mutates via ${calls.join(', ')} and never re-posts`);
  }

  assert.ok(universe > 5, `derived only ${universe} mutating handlers — the extractor is broken, not the code`);
  assert.deepEqual(offenders, [],
    'A handler changed state the pulse displays and did not re-post it. Either call host?.postState() '
    + 'at the end of it, or add it to NO_PUSH with a reason that says why the display stays correct:\n  '
    + offenders.join('\n  '));
});

test('no exemption outlives the handler it was written for', () => {
  const main = read('main.ts');
  const muts = mutators(read('aios.ts'));
  const mutating = new Set(
    handlers(main)
      .filter((h) => muts.some((mu) => new RegExp(`\\baios\\.${mu}\\s*\\(`).test(h.body)))
      .map((h) => h.channel));

  const stale = Object.keys(NO_PUSH).filter((c) => !mutating.has(c));
  assert.deepEqual(stale, [],
    `NO_PUSH exempts handlers that no longer mutate anything (renamed, deleted, or rewritten): ${stale.join(', ')}. `
    + 'Remove them — a stale exemption is how this map stops describing the code while still reading as current.');
});

test('the displayed payload has not widened under the exemptions', () => {
  const reads = postStateReads(read('panelHost.ts'));
  assert.deepEqual(reads, DISPLAYED,
    'postState() now displays a different set of values than when the NO_PUSH reasons were written. '
    + 'Re-read each exemption against the new payload, then update DISPLAYED. An exemption that was '
    + 'correct for a narrower payload is silently wrong for a wider one.');
});

test('the known-good handlers really do push (the guard can detect a push at all)', () => {
  const main = read('main.ts');
  for (const ch of ['aios:addFrequent', 'aios:removeFrequent', 'starter:apply', 'shell:setSetting']) {
    const h = handlers(main).find((x) => x.channel === ch);
    assert.ok(h, `${ch} not found — it was the fix for AI-153, so its disappearance needs a look`);
    assert.ok(h!.body.includes('postState'), `${ch} stopped calling postState() — AI-153 regressed`);
  }
});
