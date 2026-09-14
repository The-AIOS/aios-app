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
  const code = noComments(APP());
  // both surfaces — the note and the Advanced action — carry the same condition
  const conds = code.match(/modelTop && modelPinned !== modelTop\.value/g) || [];
  assert.equal(conds.length, 2, 'the note and the action must share one condition, and both must have it');
  assert.match(code, /s\.id === 'firstrun' && modelTop/, 'the note belongs to the handover step only');
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
