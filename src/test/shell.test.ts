/**
 * Shell data-layer tests — a REAL fixture framework (CLAUDE.md, USER.md, vault
 * with a today-note, .glass state) built in tmp; aios.ts reads
 * GLASS_FRAMEWORK_PATH at call time, so no import-order games.
 */
import { test, before } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as aios from '../main/aios';

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

let root = '';

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-app-fixture-'));
  process.env.GLASS_FRAMEWORK_PATH = root;
  const w = (rel: string, content: string) => {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };
  w('CLAUDE.md', '# Test framework\n');
  w('USER.md', `# USER

## Identity

| Name | Style |
|---|---|
| \`testbot\` | warm |

## Companies (mounted)

| Company | Substrate | Source | Venture folder | Last sync |
|---|---|---|---|---|
| acme | github | \`git@github.com:acme/acme-context.git\` | \`vault/...\` | 2026-06-01 |
`);
  w('vault/00 - notes/context/declared/about_me.md', 'Hi — my name is "Tester" and I build things.\n');
  const iso = todayIso();
  w(`vault/01 - calendar/${iso.slice(0, 7)}/${iso}.md`, `### Daily

> 💡 **\`/7plan\`** _maps the week before it maps you_ — go. _(suggested)_

## Agents can handle
🤖 **3 tasks agents can handle:**
- 🤖 **Draft the launch email** _(→ agent: [[email-drafter]])_
- 🤖 Ingest the keynote — \`/aios:ingest\` https://example.com/talk
- 🤖 ~~Already done thing~~ ✅ _(→ agent: [[content-writer]])_
- 🤖 **In flight thing** _(→ agent: [[deck-builder]])_ 🚀

Say "go with agents" to dispatch all, or run \`/ghost\` to answer in your voice.

## Energy
`);
  w('.glass/state.json', JSON.stringify({
    'aios.frequentTasks.v1': [{ id: 'u-review', label: 'Review PRs', kind: 'agent', target: 'technical-cofounder', hint: 'agent', assignment: 'review open PRs' }],
    'aios.frequentTasks.removed.v1': ['email'],
  }));
  w('node_modules/some-dep/index.js', '// should be excluded from the file index\n');
  w('agents/aios/communication/email-drafter.md', '---\nname: email-drafter\ndescription: Drafts emails\ntags: [agent]\n---\nbody\n');
});

test('roots resolve from the fixture framework', () => {
  assert.equal(aios.frameworkRoot(), fs.realpathSync(root));
  assert.equal(aios.vaultRoot(), path.join(fs.realpathSync(root), 'vault'));
  assert.equal(aios.primaryName(), 'testbot');
  assert.equal(aios.operatorName(), 'Tester');
});

test('frequentTasks: saved + defaults merge, removed defaults stay gone', () => {
  const tasks = aios.frequentTasks();
  const ids = tasks.map((t) => t.id);
  assert.ok(ids.includes('u-review'), 'saved task present');
  assert.ok(ids.includes('post'), 'unremoved default present');
  assert.ok(!ids.includes('email'), 'removed default stays removed');
});

test('listAgentSuggestions: open items only — struck, in-flight, and prose skipped', () => {
  const sug = aios.listAgentSuggestions();
  assert.equal(sug.length, 2, JSON.stringify(sug));
  assert.equal(sug[0].agent, 'email-drafter');
  assert.equal(sug[1].command, '/aios:ingest');
  assert.equal(sug[1].url, 'https://example.com/talk');
});

test('isIgnoredName: default scratch folders hidden, normal names shown', () => {
  // No shell.json in the fixture → ignorePaths falls back to the seeded defaults.
  assert.equal(aios.isIgnoredName('_archive'), true);
  assert.equal(aios.isIgnoredName('_workspaces'), true);
  assert.equal(aios.isIgnoredName('src'), false);
  assert.equal(aios.isIgnoredName('_archived-but-not-exact'), false); // exact basename, not substring
});

test('countAgentSuggestions: badge matches the picker; prose footer with a /command never over-counts', () => {
  // The fixture's "Agents can handle" section ends with a prose footer that
  // mentions a backticked `/ghost` — the list-item guard must keep it OUT of
  // the count (the over-count bug behind the bubble). Badge == picker length.
  assert.equal(aios.countAgentSuggestions(), 2);
  assert.equal(aios.countAgentSuggestions(), aios.listAgentSuggestions().length);
});

test('getMonthData: MMM YYYY label, today flagged with its note', () => {
  const now = new Date();
  const d = aios.getMonthData(now.getFullYear(), now.getMonth() + 1);
  assert.match(d.label, /^[A-Z][a-z]{2} \d{4}$/);
  const today = d.weeks.flat().find((c) => c.isToday);
  assert.ok(today, 'today cell exists');
  assert.ok(today && today.hasNote, 'today has its note');
});

test('nudgeState: evening → close-day; morning → the note’s 💡 ritual', () => {
  const evening = aios.nudgeState(20, 4, 0);
  assert.equal(evening && evening.kind, 'close');
  const morning = aios.nudgeState(9, 4, 0); // Thursday — weekly branch not in play
  assert.ok(morning, 'morning nudge exists');
  assert.equal(morning && morning.cmdLabel, 'Run /7plan');
});

test('readCompanies parses the USER.md table', () => {
  const c = aios.readCompanies();
  assert.equal(c.length, 1);
  assert.equal(c[0].name, 'acme');
  assert.equal(c[0].substrate, 'github');
});

test('fileIndex: vault files in, node_modules out', () => {
  const idx = aios.fileIndex();
  assert.ok(idx.some((f) => f.name === 'about_me.md'), 'vault file indexed');
  assert.ok(!idx.some((f) => f.path.includes('node_modules')), 'node_modules excluded');
});

test('discoverAgents reads only agent-tagged frontmatter', () => {
  const a = aios.discoverAgents();
  assert.equal(a.length, 1);
  assert.equal(a[0].name, 'email-drafter');
});

test('pluginCatalog: the AIOS anchor is real + installable, partners are guarded', () => {
  const cat = aios.pluginCatalog();
  const aiosPlugin = cat.find((p) => p.id === 'aios@the-aios');
  assert.ok(aiosPlugin, 'the AIOS plugin is on the shelf');
  assert.equal(aiosPlugin && aiosPlugin.status, 'available');
  assert.equal(aiosPlugin && aiosPlugin.badge, 'Official');
  // Partner Network scaffolds must never claim to be installable yet
  for (const p of cat) {
    if (p.badge === 'Coach' || p.badge === 'Plugin Partner') assert.equal(p.status, 'soon', `${p.id} must be soon`);
    assert.ok(p.marketplaceRepo, `${p.id} has a marketplace repo`);
  }
});
