#!/usr/bin/env node
/* Design gate (DESIGN.md) — hardcoded hex colors may live ONLY in renderer/theme.css.
   CSS/HTML: any hex literal is a violation. JS: only style-assignment lines are checked
   (data palettes — xterm ANSI themes, file-icon colors — are semantic data, allowed). */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'renderer');
const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/;
const JS_STYLE = /\.style\.|\.cssText|setProperty\(|insertRule\(|<style/;
let bad = 0;
for (const f of readdirSync(dir)) {
  if (f === 'theme.css' || !/\.(css|html|js)$/.test(f)) continue;
  readFileSync(join(dir, f), 'utf8').split('\n').forEach((line, i) => {
    if (HEX.test(line) && (!f.endsWith('.js') || JS_STYLE.test(line))) {
      bad++; console.error(`  ✗ renderer/${f}:${i + 1} — hardcoded hex; use a theme.css token: ${line.trim().slice(0, 90)}`);
    }
  });
}
if (bad) { console.error(`\ncheck:tokens — ${bad} forbidden hex literal(s). All color flows through :root tokens in renderer/theme.css (see DESIGN.md).`); process.exit(1); }
console.log('check:tokens ✓ no hardcoded hex outside renderer/theme.css');

/* Submit gate — a pty write of `text + CR` in ONE chunk does not submit: Claude Code reads the
   chunk as a paste and the CR lands as a literal newline in the composer (the message arrives
   but never sends). Every submit must go through submitToPty(), which writes the text and the
   CR separately. Verified by A/B against a live session; keep it from creeping back. */
const app = readFileSync(join(dir, 'app.js'), 'utf8').split('\n');
const ONE_CHUNK = /ptyWrite\([^)]*?(?:\+\s*['"`]\\r|\\r['"`]\s*\))/;
let submits = 0;
app.forEach((line, i) => {
  if (!ONE_CHUNK.test(line)) return;
  if (/setTimeout\(\(\) => window\.glassShell\.ptyWrite\(id, '\\r'\)/.test(line)) return;  // submitToPty itself
  submits++;
  console.error(`  ✗ renderer/app.js:${i + 1} — text+CR in one pty write does not submit; use submitToPty(): ${line.trim().slice(0, 90)}`);
});
if (submits) { console.error(`\ncheck:tokens — ${submits} one-chunk submit(s).`); process.exit(1); }
console.log('check:tokens ✓ all pty submits go through submitToPty');
