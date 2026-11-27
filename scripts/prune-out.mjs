#!/usr/bin/env node
/**
 * Delete compiled files in out/ whose source is gone.
 *
 * tsc writes out/<path>.js for every src/<path>.ts and never removes one when its source is
 * deleted or moved. That was survivable while files only ever got added. When the 26 shared
 * modules and their tests moved to packages/core, every existing checkout was left with
 * out/core/sendQueue.js and out/test/contract4.test.js still on disk: the old tests keep running
 * (some now failing on a fixture path that no longer exists, the rest passing against code nothing
 * else uses), and a local `npm run dist` packs the dead out/core files, because the bundle takes
 * out/ whole. CI never sees any of it; it starts from a clean tree.
 *
 * So `npm run compile` prunes first. Only .js and .js.map files are considered, and only when no
 * .ts or .tsx source sits at the same path under src/. Everything else in out/ (the copied JSON,
 * anything a script put there) is left alone.
 */
import { readdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'out');
const src = join(root, 'src');

let pruned = 0;
function walk(dir, rel) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { walk(join(dir, e.name), r); continue; }
    const m = /^(.*)\.js(\.map)?$/.exec(r);
    if (!m) continue;
    if (existsSync(join(src, `${m[1]}.ts`)) || existsSync(join(src, `${m[1]}.tsx`))) continue;
    rmSync(join(dir, e.name));
    pruned++;
  }
}
if (existsSync(out) && existsSync(src)) walk(out, '');
if (pruned) console.log(`prune-out: removed ${pruned} compiled file(s) whose source is gone`);
