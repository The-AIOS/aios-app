/**
 * No internal tracking keys in shipped code, tests or docs. Comments describe the behaviour in
 * plain words; a private roadmap key means nothing to a reader of the public repo.
 * CHANGELOG.md is history and is left as published.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = path.join(__dirname, '..', '..');
const KEY = /\bAI-\d{2,3}\b/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(rel));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

function candidates(): string[] {
  let files: string[];
  try {
    files = execFileSync('git', ['ls-files', '-z', '--', 'src', 'renderer', '*.md'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0').filter(Boolean);
  } catch {
    files = [...walk('src'), ...walk('renderer'),
      ...fs.readdirSync(ROOT).filter((f) => f.endsWith('.md'))];
  }
  return files.filter((f) => (f.startsWith('src/') || f.startsWith('renderer/') || !f.includes('/'))
    && f !== 'CHANGELOG.md' && fs.existsSync(path.join(ROOT, f)));
}

test('the tracking-key pattern matches a key (control)', () => {
  assert.match('see ' + 'AI' + '-123' + ' for details', KEY);
  assert.match('AI' + '-58', KEY);
  assert.doesNotMatch('AIOS-123 and CHAI-12 and AI-1', KEY);
});

test('no internal tracking keys in src/, renderer/ or the root docs (CHANGELOG excepted)', () => {
  const files = candidates();
  assert.ok(files.some((f) => f === 'renderer/app.js'), 'the file list must include renderer/app.js');
  assert.ok(files.some((f) => f.startsWith('src/main/')), 'the file list must include src/main');
  const hits: string[] = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n');
    lines.forEach((ln, i) => { if (KEY.test(ln)) hits.push(`${f}:${i + 1}: ${ln.trim().slice(0, 120)}`); });
  }
  assert.deepEqual(hits, [], `tracking keys found:\n${hits.join('\n')}`);
});
