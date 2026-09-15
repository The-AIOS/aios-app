/**
 * The setup step suggests the strongest model for the one conversation that earns it — and the
 * guards here are mostly about what it must NOT do.
 *
 * The suggestion is cheap to get wrong in three expensive ways: pinning the operator's model
 * behind their back, showing a recommendation to someone already on the top model (a tip that
 * fires with nothing to recommend is wallpaper), and hard-coding a model name that goes stale
 * the week Anthropic ships one. Each has an assertion below.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

const APP = (): string => fs.readFileSync(path.join(__dirname, '../../renderer/app.js'), 'utf8');
const noComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const LOC = (l: string): Record<string, string> =>
  JSON.parse(fs.readFileSync(path.join(__dirname, `../../src/i18n/locales/${l}.json`), 'utf8'));
const LOCALES = ['en', 'es', 'pt-br'];

test('the model travels per session — never into settings.json', () => {
  const code = noComments(APP());
  assert.match(code, /function spawnNamed\(name, task, cwd, mode, model\)/, 'spawnNamed must accept a model');
  assert.match(code, /\(model \? ' --model ' \+ shq\(model\) : ''\)/, 'passed only when a caller asks, and shell-quoted');
  // claudeSet('model', …) is how Settings PINS a model. The setup step must never reach for it.
  const i = code.indexOf("case 'firstrun':");
  const block = code.slice(i, code.indexOf('break;', i));
  assert.doesNotMatch(block, /claudeSet/, 'suggesting a model must not rewrite the operator\'s default');
});

test('the suggestion is silent when there is nothing to suggest', () => {
  /* Unchanged intent, updated spelling: the two surfaces still share ONE condition, but it is
     now a named function rather than an inline compare, because the compare could not see an
     alias (see the alias test below). Two copies of a condition is how they come to disagree —
     which is what this test has always been about. */
  const code = noComments(APP());
  const conds = code.match(/modelWorthSuggesting\(\)/g) || [];
  assert.equal(conds.length, 2, 'called by BOTH surfaces — the note and the Advanced action');
  assert.match(code, /const modelWorthSuggesting = \(\) => \{/, 'and defined exactly once');
  assert.match(code, /s\.id === 'firstrun' && modelWorthSuggesting\(\)/, 'the note belongs to the handover step only');
});

test('the strongest model is READ from the list, never named in the renderer', () => {
  const code = noComments(APP());
  assert.match(code, /window\.glassShell\.modelOptions\(\)/, 'the list comes from the main side');
  assert.match(code, /opts\[0\]/, 'and the top of that capability-ordered list is what gets suggested');
  // A model name written into the renderer is a fact that churns; the Settings list already
  // learned this lesson ("a list frozen in the renderer goes stale the moment Anthropic ships").
  for (const name of ['claude-opus', 'claude-sonnet', 'claude-haiku', 'Opus 5', 'Sonnet 5']) {
    assert.ok(!code.includes(name), `the renderer names ${name} — read it from modelOptions() instead`);
  }
});

test('both strings exist in every locale and carry the {model} placeholder', () => {
  for (const l of LOCALES) {
    const d = LOC(l);
    for (const k of ['setup.modelTip', 'setup.modelUse']) {
      assert.ok(d[k] && String(d[k]).trim(), `${l}: ${k} missing`);
      assert.ok(String(d[k]).includes('{model}'), `${l}: ${k} does not interpolate the model name`);
    }
    // It must read as an option, not an instruction: this step already has exactly one action.
    assert.ok(!/\bmust\b|\bdebes\b|\bprecisa\b/i.test(String(d['setup.modelTip'])),
      `${l}: the tip reads as a requirement, not a suggestion`);
  }
});

test('an ALIAS is never told to upgrade to the model it already resolves to', () => {
  /* Claude Code accepts aliases. The operator testing this was pinned to `opus[1m]`, which
     resolves to Opus 5 and does not string-match `claude-opus-5[1m]` — so a bare `!==` would
     have recommended the model they were already running. That is exactly the "fires when it
     has nothing to recommend" failure this feature was designed to avoid, arriving from the one
     direction a string compare cannot see.
     The rule is therefore narrower than not-the-top-string: suggest when nothing is pinned, or
     when the pin is a value from our own list and is not the strongest. Anything else we cannot
     rank, and silence is the honest answer. */
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'app.js'), 'utf8');
  assert.match(src, /const modelWorthSuggesting = \(\) => \{/, 'one condition, not two');
  assert.match(src, /if \(!modelKnown\.includes\(modelPinned\)\) return false;/,
    'an unrecognised pin — an alias, or an id we do not model — suggests nothing');
  assert.match(src, /if \(!modelPinned\) return true;/, 'a fresh machine is the case this exists for');
  assert.ok(!/modelPinned !== modelTop\.value\)/.test(src.replace(/return modelPinned !== modelTop\.value;/, '')),
    'both surfaces go through the one condition — a second copy is how they come to disagree');
});
