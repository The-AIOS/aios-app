#!/usr/bin/env node
/**
 * Sync the SHARED PURE CORE from the sibling aios-glass repo (single source of
 * truth for frontmatter/taskModel/memo). The panel iframe era is over — the
 * shell renders the pulse natively — but the core stays shared.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const glass = process.env.GLASS_SRC || join(root, '..', 'aios-glass');
const coreSrc = join(glass, 'src', 'core');
const coreDst = join(root, 'src', 'core');
mkdirSync(coreDst, { recursive: true });
for (const f of readdirSync(coreSrc)) if (f.endsWith('.ts')) copyFileSync(join(coreSrc, f), join(coreDst, f));
// AI-58: the per-folder sort module is pure + explicitly dual-front (Glass webview
// AND this app's explorer) — it lives in glass's src/files/ but ships to both.
copyFileSync(join(glass, 'src', 'files', 'sort.ts'), join(coreDst, 'sort.ts'));
console.log('core synced from', coreSrc);
