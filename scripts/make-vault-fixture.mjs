#!/usr/bin/env node
/**
 * make-vault-fixture — a minimal framework root, so the smoke gates RUN in CI.
 *
 * The problem this solves: `npm run smoke` boots the real workbench and asserts things about the
 * operator's framework — agents discovered, a file that renders. A bare CI runner has none of
 * that, so two gates failed on absent fixtures rather than on anything about the build, and the
 * job was kept out of the release lane for exactly that reason. They were then changed to report
 * SKIPPED instead of failing, which is honest but leaves a worse hole: a gate that CAN skip will
 * eventually skip silently, and nobody notices the day it stops running for a real reason.
 *
 * A fixture closes it from the other side. With a framework root present the gates run — and CI
 * can additionally set AIOS_SMOKE_STRICT=1, which turns "did not run" into a FAILURE. That is the
 * combination that makes the check un-skippable where it matters, without making it fail on a
 * developer's laptop that has no vault.
 *
 * Deliberately synthetic. It must never copy from an operator's real vault: this is committed
 * infrastructure and a real vault is private, so everything here is invented and generic.
 *
 * Usage:  node scripts/make-vault-fixture.mjs --out /tmp/aios-fixture
 * Then:   GLASS_FRAMEWORK_PATH=/tmp/aios-fixture AIOS_SMOKE_STRICT=1 npm run smoke
 */
import fs from 'node:fs';
import path from 'node:path';

const argIdx = process.argv.indexOf('--out');
const out = argIdx !== -1 && process.argv[argIdx + 1] ? path.resolve(process.argv[argIdx + 1]) : '';
if (!out) {
  console.error('make-vault-fixture: ✗ --out <dir> is required');
  process.exit(1);
}

const write = (rel, body) => {
  const p = path.join(out, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
};

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

/* The viewer gate opens the first of README/CLAUDE/CHEATSHEET/SETUP it finds at the root and
   counts rendered panes, so this needs real markdown with enough block content to render. */
write('README.md', `# Fixture framework root

This is a **synthetic** AIOS framework root used by CI so the smoke gates have something to
discover. It is nobody's vault.

## Why it exists

Two smoke gates read the framework: one discovers agents, commands and skills; one opens a file
and counts what rendered. On a bare runner neither had anything to measure.

- a list item, so the renderer has block content to produce
- and a second one

\`\`\`bash
echo "a fenced block, so code rendering is exercised too"
\`\`\`
`);

/* discoverAgents walks agents/** recursively, skips _index.md and anything starting with "_",
   and requires the frontmatter tags block to contain "agent". The parser reads only a
   block-style list (`tags:` alone on a line, then `- item`) — an inline array is ignored. */
write('agents/aios/personal/fixture-librarian.md', `---
tags:
  - agent
name: fixture-librarian
description: A synthetic agent that exists so discovery has something to find.
---
# Fixture Librarian

Invented for CI. Does nothing.
`);
write('agents/aios/engineering/fixture-mechanic.md', `---
tags:
  - agent
name: fixture-mechanic
description: A second synthetic agent, so a count of 1 cannot pass by accident.
---
# Fixture Mechanic
`);
/* These three must be IGNORED by discovery — they prove the filters work rather than assuming it. */
write('agents/aios/_index.md', `---\ntags:\n  - agent\n---\n# Index — must NOT be discovered\n`);
write('agents/aios/_scratch.md', `---\ntags:\n  - agent\n---\n# Underscore-prefixed — must NOT be discovered\n`);
write('agents/aios/not-an-agent.md', `---\ntags:\n  - reference\n---\n# Wrong tag — must NOT be discovered\n`);

/* discoverCommands reads plugins/aios/commands/*.md (flat, skips _index.md). */
write('plugins/aios/commands/fixture-today.md', `---
description: A synthetic command.
argumentHint: "[none]"
---
# /fixture-today
`);
write('plugins/aios/commands/_index.md', `# Index — must NOT be counted\n`);

/* discoverSkills reads skills/<group>/<name>/SKILL.md. */
write('skills/aios/fixture-skill/SKILL.md', `---
name: fixture-skill
description: A synthetic skill.
---
# Fixture Skill
`);

/* operatorName() resolves from declared context. A name is optional for the gate to pass, but
   including one exercises that resolution instead of leaving it untested. */
write('vault/00 - notes/context/declared/about_me.md', `---
tags:
  - context
---
# About me

My name is Fixture Operator and I do not exist.
`);

/* Minimal app settings. workspaceFolders is deliberately EMPTY: the viewer gate must reach its
   probe through the framework root alone. A fixture that also granted a workspace folder could
   mask the exact bug that made that gate pass on one machine and fail everywhere else. */
write('.glass/shell.json', JSON.stringify({ workspaceFolders: [] }, null, 2) + '\n');

/* Assert what was produced. A generator that quietly wrote nothing would hand the gates an empty
   root, and they would skip or fail for the original reason with a fixture nominally "in place". */
const checks = [
  ['README.md', (p) => fs.statSync(p).size > 200],
  ['agents/aios/personal/fixture-librarian.md', (p) => /^tags:\n  - agent$/m.test(fs.readFileSync(p, 'utf8'))],
  ['agents/aios/engineering/fixture-mechanic.md', () => true],
  ['plugins/aios/commands/fixture-today.md', () => true],
  ['skills/aios/fixture-skill/SKILL.md', () => true],
];
let bad = 0;
for (const [rel, ok] of checks) {
  const p = path.join(out, rel);
  let good = false;
  try { good = fs.statSync(p).isFile() && ok(p); } catch { good = false; }
  if (!good) { console.error(`make-vault-fixture: ✗ ${rel} missing or malformed`); bad++; }
}
if (bad) process.exit(1);

console.log(`make-vault-fixture: ✓ ${out}`);
console.log('  2 discoverable agents (+3 that must be filtered out), 1 command, 1 skill, a README to render');
console.log(`  use with: GLASS_FRAMEWORK_PATH="${out}" AIOS_SMOKE_STRICT=1 npm run smoke`);
