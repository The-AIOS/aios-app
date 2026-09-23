/**
 * ⌘B hides the panel, and the people who press it by accident don't know what they pressed, so
 * they can't undo it (operator-reported 2026-09-22). Choosing any layout that has a panel now
 * brings it back. The layout menu is where a lost person goes looking. Zen has no panel, so
 * choosing Zen changes nothing about it.
 *
 * Runs the real choosePreset, and checks that both ways to choose a layout (the title-bar menu
 * and ⌘1–4) go through it. A third path that set `preset` directly would bring back the old bug.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

const app = fs.readFileSync('renderer/app.js', 'utf8');

function run(start: { preset: string; pOn: boolean; lastPanelPreset: string }, choose: string) {
  const m = /function choosePreset\(name\) \{[\s\S]*?\n\}/.exec(app);
  assert.ok(m, 'choosePreset must be findable in renderer/app.js');
  const s = { ...start };
  const fn = new Function('s', `
    let { preset, pOn, lastPanelPreset } = s;
    const hasPanel = (pr = preset) => pr !== 'Zen';
    ${m![0]}
    choosePreset(${JSON.stringify(choose)});
    return { preset, pOn, lastPanelPreset };`);
  return fn(s) as typeof start;
}

test('panel hidden by ⌘B → choosing a layout brings it back, including the one you are already on', () => {
  for (const name of ['Stacked', 'Facing', 'IDE']) {
    const r = run({ preset: 'Facing', pOn: false, lastPanelPreset: 'Facing' }, name);
    assert.equal(r.pOn, true, `${name}: panel is back`);
    assert.equal(r.preset, name);
    assert.equal(r.lastPanelPreset, name, 'and it is remembered for the way back out of Zen');
  }
});

test('choosing Zen leaves the panel setting alone — Zen has no panel by design', () => {
  const hidden = run({ preset: 'Facing', pOn: false, lastPanelPreset: 'IDE' }, 'Zen');
  assert.equal(hidden.pOn, false);
  assert.equal(hidden.lastPanelPreset, 'IDE', 'Zen is never remembered as the layout to return to');
  const shown = run({ preset: 'Facing', pOn: true, lastPanelPreset: 'Facing' }, 'Zen');
  assert.equal(shown.pOn, true);
});

test('every explicit layout choice goes through choosePreset', () => {
  const direct = [...app.matchAll(/^\s*preset = (?!lastPanelPreset\b)[^;]+;/gm)].map((x) => x[0].trim());
  assert.deepEqual(direct, ['preset = name;'],
    'the only direct assignment is inside choosePreset (the ⌘B/folder toggles set preset = lastPanelPreset, which already shows the panel)');
  assert.match(app, /b\.addEventListener\('click', \(\) => \{ choosePreset\(name\);/, 'the title-bar layout menu');
  assert.match(app, /if \(m\.preset && LAYOUTS\.includes\(m\.preset\)\) choosePreset\(m\.preset\);/, '⌘1–4 from the native menu');
});
