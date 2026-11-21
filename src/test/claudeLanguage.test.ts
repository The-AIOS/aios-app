/** Claude answers in the App's language, without ever overriding a language the operator chose. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { decideClaudeLanguage, claudeLanguageFor, CLAUDE_LANGUAGE } from '../core/claudeLanguage';
import { LOCALES } from '../i18n';

const ROOT = path.join(__dirname, '..', '..');
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('every App locale has an entry, and English leaves Claude matching the operator', () => {
  for (const l of LOCALES) assert.ok(Object.prototype.hasOwnProperty.call(CLAUDE_LANGUAGE, l), `${l} has no Claude language`);
  assert.equal(claudeLanguageFor('en'), null);
  assert.equal(claudeLanguageFor('fr'), 'French');
  assert.equal(claudeLanguageFor('xx'), null);
});

test('a fresh vault in a French App gets language: French', () => {
  assert.deepEqual(decideClaudeLanguage({ target: 'French' }), { kind: 'set', value: 'French' });
});

test('switching the App language moves the value the App wrote', () => {
  assert.deepEqual(decideClaudeLanguage({ local: 'French', synced: 'French', target: 'Spanish' }), { kind: 'set', value: 'Spanish' });
  assert.deepEqual(decideClaudeLanguage({ local: 'French', synced: 'French', target: 'French' }), { kind: 'keep' });
});

test('back to English removes only what the App wrote', () => {
  assert.deepEqual(decideClaudeLanguage({ local: 'French', synced: 'French', target: null }), { kind: 'unset' });
  assert.deepEqual(decideClaudeLanguage({ target: null }), { kind: 'keep' });
});

test('a language the operator set locally is never touched', () => {
  assert.deepEqual(decideClaudeLanguage({ local: 'japanese', synced: 'French', target: 'Spanish' }), { kind: 'keep' });
  assert.deepEqual(decideClaudeLanguage({ local: 'japanese', target: null }), { kind: 'keep' });
});

test('a language set globally or in the project wins: the App steps aside and removes its own', () => {
  assert.deepEqual(decideClaudeLanguage({ elsewhere: 'english', target: 'French' }), { kind: 'keep' });
  assert.deepEqual(decideClaudeLanguage({ local: 'French', synced: 'French', elsewhere: 'english', target: 'French' }), { kind: 'unset' });
});

test('the sync runs on boot and when the language changes, and the setup brief names the language', () => {
  const main = read('src/main/main.ts');
  assert.match(main, /aios\.applyLocale\(\);[^\n]*\n\s*aios\.syncClaudeLanguage\(\);[^\n]*\n\s*const win = createWindow\(\)/, 'boot');
  assert.match(main, /if \(key === 'locale'\) \{\s*aios\.applyLocale\(\);[^\n]*\n\s*aios\.syncClaudeLanguage\(\);/, 'on change');
  const app = read('renderer/app.js');
  assert.match(app, /\+ setupLanguageLine\(\)\s*\n\s*\+ 'Work through it with me interactively\.'/, 'setup brief');
});

test('0.17.0 review: a settings file that does not parse is never rewritten, and auto never sets a language', () => {
  const aiosSrc = require('fs').readFileSync('src/main/aios.ts', 'utf8') as string;
  assert.match(aiosSrc, /const j = readJsonForWrite\(p\);\n  if \(!j\) \{ console\.warn\('\[claude-settings\] not writing'/, 'the local writer refuses an unparseable file');
  assert.equal((aiosSrc.match(/const j = readJsonForWrite\(p\);/g) || []).length, 2, 'both Claude settings writers');
  assert.match(aiosSrc, /if \(!writeClaudeLocalSettings\(\(j\) => \{ j\.language = action\.value; \}\)\) return 'keep';/, 'the marker moves only with a write that happened');
  assert.match(aiosSrc, /if \(!raw\.trim\(\)\) return \{\};/, 'an empty file is not a broken one');
  assert.match(aiosSrc, /target: shellSettings\(\)\.locale === 'auto' \? null : claudeLanguageFor\(resolvedLocale\(\)\)/, 'only a language the operator chose');
});
