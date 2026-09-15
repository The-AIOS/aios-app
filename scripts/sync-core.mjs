#!/usr/bin/env node
/**
 * Sync the SHARED PURE CORE from the sibling aios-glass repo.
 *
 * REPORTS BEFORE IT WRITES, AND REFUSES TO CLOBBER SILENTLY — which it did not do until
 * 2026-09-15, when running it mid-branch reverted 276 lines of this repo's newer core and said
 * only `core synced from …`. It was caught by the next compile; nothing about the script itself
 * would have told anyone. A one-way copy whose direction is an assumption is a footgun, because
 * the assumption ("glass is ahead") is true only until someone edits here.
 *
 * So: every file is classified first. `--force` is the escape hatch, and it names what it
 * replaced rather than hiding it.
 *
 *   node scripts/sync-core.mjs            report + apply only what is safe
 *   node scripts/sync-core.mjs --force     apply everything, naming each clobber
 *   node scripts/sync-core.mjs --check     report only, exit 1 on any divergence (CI-friendly)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const glass = process.env.GLASS_SRC || join(root, '..', 'aios-glass');
const coreSrc = join(glass, 'src', 'core');
const coreDst = join(root, 'src', 'core');
const FORCE = process.argv.includes('--force');
const CHECK = process.argv.includes('--check');

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12);

/* The pinned files: a cross-repo hash test asserts these are byte-identical, so a difference here
   is never "glass is ahead" — it is a contract break, and copying over it would hide which side
   moved. Listed by name because the pin lives in the test file, not in the source. */
const PINNED = new Set(['attention.ts', 'presence.ts', 'resumeTarget.ts', 'busVerbs.ts',
  'sendQueue.ts', 'busPayload.ts']);

mkdirSync(coreDst, { recursive: true });
const files = [
  ...readdirSync(coreSrc).filter((f) => f.endsWith('.ts')).map((f) => [join(coreSrc, f), join(coreDst, f), f]),
  /* AI-58: the per-folder sort module is pure + explicitly dual-front (Glass webview AND this
     app's explorer) — it lives in glass's src/files/ but ships to both. */
  [join(glass, 'src', 'files', 'sort.ts'), join(coreDst, 'sort.ts'), 'sort.ts'],
];

const same = [], added = [], diverged = [];
for (const [src, dst, name] of files) {
  if (!existsSync(dst)) { added.push([src, dst, name]); continue; }
  if (sha(src) === sha(dst)) { same.push(name); continue; }
  diverged.push([src, dst, name]);
}

for (const [src, dst, name] of added) { writeFileSync(dst, readFileSync(src)); console.log(`  + ${name} (new here)`); }
console.log(`  = ${same.length} already identical`);

let failed = false;
for (const [src, dst, name] of diverged) {
  const pinned = PINNED.has(name);
  if (CHECK || (!FORCE && pinned)) {
    console.error(`  ! ${name} DIFFERS${pinned ? ' — and it is PINNED byte-identical' : ''}`);
    console.error(`      glass ${sha(src)}   here ${sha(dst)}`);
    console.error(pinned
      ? '      A pinned file differing means one side moved without the other. Do NOT copy over it — find '
        + 'which side changed, make the edit in both, and update the SHA in both test files.'
      : '      Refusing to overwrite. Re-run with --force once you know this repo is not the newer side.');
    failed = true;
    continue;
  }
  if (!FORCE) { console.error(`  ! ${name} differs — refusing (use --force)`); failed = true; continue; }
  writeFileSync(dst, readFileSync(src));
  console.log(`  ↻ ${name} OVERWRITTEN (was ${sha(dst)})`);
}

if (failed) {
  console.error('sync-core: nothing was silently replaced. Resolve the files above, then re-run.');
  process.exit(1);
}
console.log(`sync-core: core synced from ${coreSrc}`);
