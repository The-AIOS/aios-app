#!/usr/bin/env node
/**
 * Sync `sort.ts` from the sibling aios-glass repo — the ONE shared file that is still a copy.
 *
 * Everything else the App and Glass share is `@the-aios/core` (packages/core): one published
 * version, no copy, nothing to sync. This script used to copy all of Glass's `src/core/` here; run
 * that way today it would write back the very copies the package replaced, so it no longer looks
 * at that folder at all. `sort.ts` lives in Glass's `src/files/` and is not in the package yet. It
 * is the next file to move there, and this script goes away when it does.
 *
 * REPORTS BEFORE IT WRITES, AND REFUSES TO CLOBBER SILENTLY — which it did not do until
 * 2026-09-15, when running it mid-branch reverted 276 lines of this repo's newer core and said
 * only `core synced from …`. A one-way copy whose direction is an assumption is a footgun, because
 * the assumption ("glass is ahead") is true only until someone edits here.
 *
 *   node scripts/sync-core.mjs            report + apply only what is safe
 *   node scripts/sync-core.mjs --force     apply, naming the clobber
 *   node scripts/sync-core.mjs --check     report only, exit 1 on any divergence (CI-friendly)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const glass = process.env.GLASS_SRC || join(root, '..', 'aios-glass');
const coreDst = join(root, 'src', 'core');
const FORCE = process.argv.includes('--force');
const CHECK = process.argv.includes('--check');

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12);

mkdirSync(coreDst, { recursive: true });
/* The per-folder sort module is pure + explicitly dual-front (Glass webview AND this app's
   explorer) — it lives in glass's src/files/ but ships to both. */
const files = [
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
  if (CHECK) {
    console.error(`  ! ${name} DIFFERS`);
    console.error(`      glass ${sha(src)}   here ${sha(dst)}`);
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
console.log(`sync-core: sort.ts synced from ${glass}`);
