#!/usr/bin/env node
/**
 * demo — boot the App into a synthetic story: a fictional operator, her vault, today's
 * note and three live-looking sessions. For screenshots, a live talk, and the launch film, with
 * NO real vault, session, account or inbox anywhere on screen.
 *
 * WHY A WHOLE FAKE HOME, not just a fake vault. The App reads far more than the vault: Claude's
 * session registry (~/.claude/sessions — the Running list), ~/.claude.json (the account email in
 * Settings), ~/.claude/settings.json (model, effort), ~/.aios (the inbox, presence). A fake vault
 * alone would put the presenter's real session names and email on a projector. Pointing HOME at
 * a synthetic home isolates every one of them in one move, which is the only kind of isolation
 * that does not depend on remembering every path.
 *
 * The three "sessions" are `sleep` stand-ins: the registry only lists a session whose pid is
 * alive, so each gets a real, harmless process. They are killed when the App exits.
 *
 * Usage:  npm run demo                (builds, launches, cleans up the stand-ins on exit)
 *         node scripts/demo.mjs --build-only --out <dir>   (just the home, for inspection)
 * Everything here is invented. Never copy from a real vault into this file.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const argOut = process.argv.indexOf('--out');
const HOME = argOut !== -1 ? path.resolve(process.argv[argOut + 1]) : path.join(os.tmpdir(), 'aios-demo-home');
const BUILD_ONLY = process.argv.includes('--build-only');

const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const month = today.slice(0, 7);

const write = (rel, body) => {
  const p = path.join(HOME, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
};

export function buildDemoHome() {
  fs.rmSync(HOME, { recursive: true, force: true });
  const V = 'aios/vault/00 - notes';

  write('aios/README.md', '# AIOS — demo workspace\n\nA synthetic story for demos. Nothing here is real.\n');
  write('aios/USER.md', '# USER.md\n\n## Settings\n\n- **Automatic updates:** no\n');
  write('aios/.glass/shell.json', JSON.stringify({ workspaceFolders: [], theme: 'light', showMemory: false }, null, 2) + '\n');

  write(`${V}/context/declared/about_me.md`, `---\ntags:\n  - context\n---\n# About me\n\nMy name is Ana Ruiz. I run Casa Norte, a family bakery with four shops, and I am opening a fifth this spring.\n`);
  write(`${V}/projects/_index.md`, `# Projects\n\n- [[casanorte-fifth-shop]] — active — the new shop on Calle Luna\n- [[casanorte-supplier-review]] — active — flour and dairy contracts for next year\n- [[personal-marathon]] — active — training for October\n`);
  write(`${V}/projects/casanorte-fifth-shop.md`, `---\nstatus: active\n---\n# Fifth shop — Calle Luna\n\n## Next\n- [ ] Sign the lease (Friday)\n- [ ] Hire a shop lead\n- [ ] Opening-week menu\n`);
  write(`${V}/projects/casanorte-supplier-review.md`, `---\nstatus: active\n---\n# Supplier review\n\n## Next\n- [ ] Compare the three flour quotes\n- [ ] Draft the dairy renegotiation email\n`);
  write(`${V}/projects/personal-marathon.md`, `---\nstatus: active\n---\n# Marathon\n\n## Next\n- [ ] Long run Sunday — 24 km\n`);

  for (const [name, desc] of [
    ['finance-review', 'Reads quotes, invoices and forecasts and says what changed and why it matters.'],
    ['marketing-copy', 'Writes menus, posts and signage in the house voice, in Spanish and English.'],
    ['inbox-triage', 'Sorts the morning inbox into reply, delegate and archive.'],
  ]) {
    write(`aios/agents/aios/personal/${name}.md`, `---\ntags:\n  - agent\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\n\n${desc}\n`);
  }

  write(`aios/vault/01 - calendar/${month}/${today}.md`, `---\ntags:\n  - daily\n---\n# ${today}\n\n## Today I ship\n- [ ] Sign the Calle Luna lease\n- [x] Approve the opening-week menu ✅\n- [ ] Send the dairy renegotiation email\n\n## Agents can handle\n**3 tasks agents can handle:**\n- 🤖 Compare the three flour quotes _(→ agent: [[finance-review]])_\n- 🤖 Draft the opening-week Instagram posts _(→ agent: [[marketing-copy]])_\n- 🤖 Sort this morning's inbox _(→ agent: [[inbox-triage]])_\n\n## Energy note\nGood morning. The lease is the one thing that matters today.\n`);

  write('.claude/settings.json', JSON.stringify({ model: 'opus[1m]', effortLevel: 'high' }, null, 2) + '\n');
  write('.claude.json', JSON.stringify({ oauthAccount: { emailAddress: 'ana@casanorte.example' }, hasCompletedOnboarding: true }, null, 2) + '\n');
  fs.mkdirSync(path.join(HOME, '.claude', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(HOME, '.aios'), { recursive: true });
  return HOME;
}

/** Three sessions in three states, each backed by a harmless live process. */
function startStandIns() {
  const stories = [
    { name: 'marketing-copy', status: 'busy' },
    { name: 'finance-review', status: 'waiting', waitingFor: 'approve Write: flour-quotes-comparison.xlsx' },
    { name: 'inbox-triage', status: 'idle' },
  ];
  const procs = [];
  const t0 = Date.now();
  stories.forEach((s, i) => {
    const p = spawn('/bin/sleep', ['86400'], { stdio: 'ignore' });
    procs.push(p);
    const sid = `00000000-demo-4000-8000-00000000000${i + 1}`;
    fs.writeFileSync(path.join(HOME, '.claude', 'sessions', `${p.pid}.json`), JSON.stringify({
      pid: p.pid, sessionId: sid, name: s.name, cwd: path.join(HOME, 'aios'), kind: 'interactive', entrypoint: 'cli',
      status: s.status, ...(s.waitingFor ? { waitingFor: s.waitingFor } : {}),
      startedAt: t0 - (i + 1) * 17 * 60_000, updatedAt: t0, statusUpdatedAt: t0 - (i + 2) * 60_000,
    }));
  });
  return procs;
}

function checks() {
  const must = [
    'aios/vault/00 - notes/context/declared/about_me.md',
    `aios/vault/01 - calendar/${month}/${today}.md`,
    'aios/agents/aios/personal/finance-review.md',
    '.claude.json',
  ];
  for (const rel of must) if (!fs.existsSync(path.join(HOME, rel))) { console.error(`demo: ✗ missing ${rel}`); process.exit(1); }
}

buildDemoHome();
checks();
if (BUILD_ONLY) { console.log(`demo: ✓ home at ${HOME}`); process.exit(0); }

const procs = startStandIns();
const electron = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
const app = spawn(electron, ['.', `--user-data-dir=${path.join(HOME, '.userdata')}`, '--use-mock-keychain', ...process.argv.slice(2).filter((a) => a.startsWith('--eval='))], {
  cwd: ROOT, stdio: 'inherit',
  env: { ...process.env, HOME, USERPROFILE: HOME, AIOS_BUS_DISABLED: '1', GLASS_FRAMEWORK_PATH: path.join(HOME, 'aios') },
});
const cleanup = () => { for (const p of procs) { try { p.kill(); } catch { /* gone */ } } };
app.on('exit', (code) => { cleanup(); process.exit(code ?? 0); });
process.on('SIGINT', () => { app.kill(); });
