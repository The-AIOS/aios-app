#!/usr/bin/env node
/* Remove a build output folder before compiling into it. tsc never deletes what it wrote for a
   source file that has since been removed: a deleted test would keep running from .test-out/, and
   a deleted module would keep shipping from dist/. Only the two folders this package builds. */
import { rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
for (const dir of process.argv.slice(2)) {
  if (dir !== 'dist' && dir !== '.test-out') { console.error(`clean: refusing ${dir}`); process.exit(2); }
  rmSync(join(root, dir), { recursive: true, force: true });
}
