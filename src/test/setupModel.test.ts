/**
 * The setup step runs the one conversation that writes the vault on a model worth writing it.
 *
 * The first version of this feature got the ARGUMENT right and the ARRANGEMENT wrong: it showed
 * a note saying the interview deserves the strongest model, and put the button that uses one
 * behind a collapsed `<details>` while the primary button inherited whatever was pinned. An
 * operator pinned Haiku deliberately, pressed the big button, and the interview ran on Haiku —
 * working exactly as built. So the lanes swapped, and most of what follows guards the ways that
 * swap could go wrong: overriding a choice we cannot rank, pinning a model behind someone's
 * back, or recommending a model id that no longer exists.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { recommendedModel, rankPinnedModel, modelOptions } from '../main/aios';

const APP = (): string => fs.readFileSync(path.join(__dirname, '../../renderer/app.js'), 'utf8');
const noComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const LOC = (l: string): Record<string, string> =>
  JSON.parse(fs.readFileSync(path.join(__dirname, `../../src/i18n/locales/${l}.json`), 'utf8'));
const LOCALES = ['en', 'es', 'pt-br'];

test('the recommendation is an ALIAS, so a retired generation cannot break setup', () => {
  /* MEASURED against the real CLI, not assumed: `claude --model <unknown-id>` does not fall back
     to anything. It prints `[claude-code:unrecognized_model]` and refuses — "It may not exist or
     you may not have access to it". So a pinned generation here is a hard error waiting for the
     day Anthropic retires it, landed on a NEWCOMER, in the one conversation that writes the
     context every later session reads.
     An alias is resolved by Claude Code itself and cannot go stale. */
  const rec = recommendedModel();
  assert.match(rec.value, /^opus(\[1m\])?$/,
    'an alias, not a dated id — a generation in this string is a scheduled outage');
  assert.ok(!/^claude-/.test(rec.value), 'a concrete model id is exactly what must not be here');
  assert.ok(rec.label && rec.label.trim(), 'and it is named for a human');
  // returned by value: a caller must not be able to mutate the recommendation for everyone else
  recommendedModel().value = 'mutated';
  assert.notEqual(recommendedModel().value, 'mutated');
});

test('ranking a pin: absent, weaker, stronger-or-equal, and UNKNOWN as a real answer', () => {
  assert.equal(rankPinnedModel(''), 'absent', 'nothing chosen — the newcomer this exists for');
  assert.equal(rankPinnedModel('   '), 'absent', 'whitespace is not a choice');

  assert.equal(rankPinnedModel('claude-haiku-4-5-20251001'), 'weaker', 'the operator\'s own report');
  assert.equal(rankPinnedModel('claude-sonnet-5'), 'weaker');
  assert.equal(rankPinnedModel('haiku'), 'weaker', 'aliases rank too — a string compare could not');
  assert.equal(rankPinnedModel('sonnet[1m]'), 'weaker');

  assert.equal(rankPinnedModel('claude-opus-5[1m]'), 'stronger-or-equal');
  assert.equal(rankPinnedModel('opus[1m]'), 'stronger-or-equal', 'the alias an operator actually runs');
  assert.equal(rankPinnedModel('opus'), 'stronger-or-equal',
    'already Opus — nudging them to the 1M variant is a tip with nothing to say');
  assert.equal(rankPinnedModel('OPUS'), 'stronger-or-equal', 'case is not a choice either');

  /* THE ANSWER THAT PROTECTS A DELIBERATE CHOICE. An account extra carries its own quota and is
     described as most capable for the hardest tasks; a provider id is someone routing on
     purpose. Ranking either against a generic recommendation is a guess, and acting on the guess
     would override a decision we cannot see the reasons for. */
  assert.equal(rankPinnedModel('claude-fable-5-1'), 'unknown');
  assert.equal(rankPinnedModel('some-provider/some-model'), 'unknown');

  /* A FUTURE GENERATION OF A KNOWN FAMILY STILL RANKS. The family is the scale, not the version,
     so `claude-opus-9` is not silently demoted to "unknown" the week it ships. */
  assert.equal(rankPinnedModel('claude-opus-9'), 'stronger-or-equal');
  assert.equal(rankPinnedModel('claude-haiku-9'), 'weaker');
});

test('the recommendation never ranks itself as something to recommend', () => {
  /* The loop this closes: whatever we recommend, an operator who takes it is then pinned to it,
     and must not be told to upgrade to what they are already running. */
  assert.equal(rankPinnedModel(recommendedModel().value), 'stronger-or-equal');
});

test('the picker still offers concrete generations, and labels the operator\'s own pin', () => {
  /* Ranking and CHOOSING are different jobs. The recommendation is an alias because it must
     survive a rename; the picker names generations because a person choosing wants to name one. */
  const opts = modelOptions();
  assert.ok(opts.length >= 4, 'the standard ladder is still offered');
  assert.ok(opts.some((o) => /^claude-opus/.test(o.value)), 'with concrete ids, not aliases');
  for (const o of opts) assert.ok(o.label && o.label.trim(), `every option is named (${o.value})`);
});

test('the model travels per session — never into settings.json', () => {
  const code = noComments(APP());
  assert.match(code, /function spawnNamed\(name, task, cwd, mode, model\)/, 'spawnNamed must accept a model');
  assert.match(code, /\(model \? ' --model ' \+ shq\(model\) : ''\)/, 'passed only when a caller asks, and shell-quoted');
  // claudeSet('model', …) is how Settings PINS a model. The setup step must never reach for it.
  const i = code.indexOf("case 'firstrun':");
  const block = code.slice(i, code.indexOf('break;', i));
  assert.doesNotMatch(block, /claudeSet/, 'suggesting a model must not rewrite the operator\'s default');
});

test('the PRIMARY button carries the recommendation, and the operator\'s own stays one click away', () => {
  /* The defect this replaced. `primary: true` sat on the button that passed NO model, so the
     default path ran the interview on whatever was pinned while the note beside it argued for
     something better. Both lanes are asserted together because the bug was their arrangement,
     not either one alone. */
  const code = noComments(APP());
  const i = code.indexOf("case 'firstrun':");
  assert.notEqual(i, -1, 'the handover step must exist');
  const block = code.slice(i, code.indexOf('break;', i));

  assert.match(block, /mkBtn\(acts, t\('setup\.phase2Model'[\s\S]{0,200}?spawnSetupSession\(modelRec\.value\)[\s\S]{0,120}?primary: true/,
    'the recommendation IS the primary action');
  assert.match(block, /mkBtn\(adv,[\s\S]{0,220}?spawnSetupSession\(\)\)/,
    'and Advanced runs it with no model, which is what inherits the operator\'s own');
  /* Passing NO model is also what makes the Advanced lane correct on a fresh machine: there is
     nothing pinned to pass, so it simply defers to Claude Code. */
  assert.doesNotMatch(block, /spawnSetupSession\(modelPinned\)/,
    'never re-pass the pin explicitly — absent is not the same as a value');

  // and when there is nothing to recommend, one plain button, unchanged
  assert.match(block, /\} else \{\s*mkBtn\(acts, t\('setup\.phase2'\), \(\) => spawnSetupSession\(\)/,
    'silent case keeps the original single action');
});

test('one condition drives both surfaces, and it reads the RANK', () => {
  const code = noComments(APP());
  const conds = code.match(/modelWorthSuggesting\(\)/g) || [];
  assert.equal(conds.length, 2, 'called by BOTH surfaces — the note and the buttons');
  assert.match(code, /const modelWorthSuggesting = \(\) => \{/, 'and defined exactly once');
  assert.match(code, /s\.id === 'firstrun' && modelWorthSuggesting\(\)/, 'the note belongs to the handover step only');
  assert.match(code, /modelPinRank === 'absent' \|\| modelPinRank === 'weaker'/,
    'suggest only when we can tell the pin is weaker, or nobody chose — `unknown` stays silent');
  assert.match(code, /modelPinned === modelRec\.value\) return false/,
    'and never recommend what is already pinned');
});

test('no model name is written into the renderer', () => {
  // A model name in the renderer is a fact that churns; the main side owns every one of them.
  const code = noComments(APP());
  assert.match(code, /window\.glassShell\.recommendedModel\(\)/, 'the recommendation comes from main');
  assert.match(code, /window\.glassShell\.rankPinnedModel\(/, 'and so does the ranking');
  for (const name of ['claude-opus', 'claude-sonnet', 'claude-haiku', 'Opus 5', 'Sonnet 5', 'opus[1m]']) {
    assert.ok(!code.includes(name), `the renderer names ${name} — read it from the main side instead`);
  }
});

test('every setup-model string exists in all three locales, with its placeholder', () => {
  for (const l of LOCALES) {
    const d = LOC(l);
    for (const k of ['setup.modelTip', 'setup.phase2Model', 'setup.modelMine']) {
      assert.ok(d[k] && String(d[k]).trim(), `${l}: ${k} missing`);
      assert.ok(String(d[k]).includes('{model}'), `${l}: ${k} does not interpolate the model name`);
    }
    assert.ok(d['setup.modelDefault'] && String(d['setup.modelDefault']).trim(),
      `${l}: setup.modelDefault missing — the fresh-machine lane has no pin to name`);
    assert.ok(!String(d['setup.modelDefault']).includes('{model}'),
      `${l}: nothing is pinned in that case, so there is no name to interpolate`);
    /* It must read as a choice, not an instruction — and it must say the operator's own default
       is untouched, because the primary button now changes what runs. */
    assert.ok(!/\bmust\b|\bdebes\b|\bprecisa\b/i.test(String(d['setup.modelTip'])),
      `${l}: the tip reads as a requirement, not a choice`);
  }
});
