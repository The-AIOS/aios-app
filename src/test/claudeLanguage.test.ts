/** Claude's language is the operator's own choice, beside the App's: never changed with it, only suggested (0.17.0 hand test). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { claudeLanguageFor, claudeLanguageChoice, claudeLanguageSuggestion, CLAUDE_LANGUAGES } from '@the-aios/core/claudeLanguage';
import { LOCALES } from '../i18n';

const ROOT = path.join(__dirname, '..', '..');
const read = (p: string): string => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('every App locale can be chosen for Claude, and English matching means "the language you write in"', () => {
  for (const l of LOCALES) assert.ok(CLAUDE_LANGUAGES.some((c) => c.locale === l), l);
  assert.equal(claudeLanguageFor('en'), null);
  assert.equal(claudeLanguageFor('fr'), 'French');
  assert.equal(claudeLanguageFor('xx'), null);
});

test('only a listed language, or nothing, is ever written', () => {
  assert.equal(claudeLanguageChoice('spanish'), 'Spanish');
  assert.equal(claudeLanguageChoice(null), null);
  assert.equal(claudeLanguageChoice(''), null);
  assert.equal(claudeLanguageChoice('Klingon'), undefined);
  assert.equal(claudeLanguageChoice(42), undefined);
});

test('after the App language changes, matching is suggested only when Claude does not already match', () => {
  assert.deepEqual(claudeLanguageSuggestion('es', null), { value: 'Spanish' }, 'Spanish App, Claude follows the operator: ask');
  assert.equal(claudeLanguageSuggestion('es', 'spanish'), null, 'already Spanish');
  assert.deepEqual(claudeLanguageSuggestion('en', 'Spanish'), { value: null }, 'back to English: offer the language you write in');
  assert.equal(claudeLanguageSuggestion('en', null), null);
  assert.equal(claudeLanguageSuggestion('en', 'English'), null, 'an English App with Claude in English already matches');
  assert.deepEqual(claudeLanguageSuggestion('fr', 'Japanese'), { value: 'French' }, 'a value from /config is asked about, never overwritten silently');
  assert.equal(claudeLanguageSuggestion('xx', null), null);
});

test('nothing writes Claude\'s language on boot or when the App language changes: only the operator\'s pick', () => {
  const main = read('src/main/main.ts');
  const aios = read('src/main/aios.ts');
  assert.doesNotMatch(main + aios, /syncClaudeLanguage/, 'the automatic sync is gone (it made a Spanish App answer English prompts in Spanish)');
  assert.match(main, /if \(key === 'locale'\) \{\s*aios\.applyLocale\(\);[^\n]*\n\s*rebuildMenu\(\);/, 'a locale change only relabels');
  assert.match(main, /ipcMain\.handle\('claude:setLanguage', \(_e, v: unknown\) => aios\.setClaudeLanguage\(v\)\);/);
  const app = read('renderer/app.js');
  assert.match(app, /claudeLangAsk = cl && cl\.suggest \? cl\.suggest : null;\n\s*relocalize\(/, 'the App language change only ASKS');
  assert.match(app, /let asked = claudeLangAsk;\n\s*claudeLangAsk = null;/, 'the question is taken by the Settings tab that shows it, never shown again on a later open (review)');
  assert.match(read('src/main/aios.ts'), /suggest: sg && sg\.value === null && !l \? null : sg/, 'no question the App cannot carry out (review)');
  assert.match(app, /row\(wrap, t\('settings\.language'\), langSel, t\('settings\.languageHint'\)\);\n\s*settingsClaudeLanguageRow\(wrap\);/, 'the choice sits right under the App language');
  assert.match(app, /\+ setupLanguageLine\(\)\s*\n\s*\+ 'Work through it with me interactively\.'/, 'setup brief');
});

test('a settings file that does not parse is never rewritten', () => {
  const aiosSrc = read('src/main/aios.ts');
  assert.match(aiosSrc, /const j = readJsonForWrite\(p\);\n  if \(!j\) \{ console\.warn\('\[claude-settings\] not writing'/, 'the local writer refuses an unparseable file');
  assert.equal((aiosSrc.match(/const j = readJsonForWrite\(p\);/g) || []).length, 2, 'both Claude settings writers');
  assert.match(aiosSrc, /if \(!raw\.trim\(\)\) return \{\};/, 'an empty file is not a broken one');
  assert.match(aiosSrc, /const choice = claudeLanguageChoice\(v\);\n  if \(choice === undefined\) return false;/, 'an unknown value is refused');
});
