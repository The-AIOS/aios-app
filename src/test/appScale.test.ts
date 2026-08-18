/**
 * Interface Size (PR #10, from a Windows operator) — the clamp and the reset.
 *
 * The contribution is sound and deliberately additive: a second visible control beside Editor
 * Zoom, wired to `applyAppScale` (native page zoom + `fitTerms()`), persisted through the same
 * `appFontSize` key the Settings field writes so the two cannot disagree. It cited
 * `menu.test.ts`'s accelerator-uniqueness assertion, which does cover the new items — but it
 * shipped no test for `stepAppScale` itself, and the clamp arithmetic is where this kind of
 * control goes wrong.
 *
 * The bug it fixes is worth restating, because it is the same class the pill work hit: `Ctrl +`
 * reported a NEW PERCENTAGE while nothing on screen changed. A no-op that announces success is
 * worse than one that stays quiet — it moves the operator from "this did nothing" to "this is
 * lying to me". Hence the trailing `·` marker at the clamp, asserted below.
 *
 * Executed against the real function rather than pattern-matched: the guarantee is arithmetic.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

const app = fs.readFileSync('renderer/app.js', 'utf8');

function harness() {
  const m = /const APP_SCALE_MIN = [\s\S]*?\nasync function stepAppScale\(delta\) \{[\s\S]*?\n\}/.exec(app);
  assert.ok(m, 'stepAppScale and its bounds must be findable');
  const calls: { applied: number[]; saved: Array<[string, number]>; toasts: string[] } =
    { applied: [], saved: [], toasts: [] };
  const fn = new Function('applyAppScale', 'window', 'toast', 't', `
    ${m![0]}
    return { stepAppScale, get scale() { return appScale; }, set scale(v) { appScale = v; } };`)(
    (n: number) => calls.applied.push(n),
    { glassShell: { setSetting: async (k: string, v: number) => { calls.saved.push([k, v]); } } },
    (s: string) => calls.toasts.push(s),
    (_k: string, vars?: Record<string, string>) => `pct=${vars?.pct}`,
  ) as { stepAppScale: (d: number | null) => Promise<void>; scale: number };
  return { fn, calls };
}

test('stepping clamps at both ends instead of running away', async () => {
  const { fn } = harness();
  for (let i = 0; i < 20; i++) await fn.stepAppScale(1);
  assert.equal(fn.scale, 18, 'never above APP_SCALE_MAX');
  for (let i = 0; i < 40; i++) await fn.stepAppScale(-1);
  assert.equal(fn.scale, 10, 'never below APP_SCALE_MIN');
});

test('reset returns to 100%, from either direction', async () => {
  const { fn } = harness();
  await fn.stepAppScale(1); await fn.stepAppScale(1);
  await fn.stepAppScale(null);
  assert.equal(fn.scale, 13, 'APP_SCALE_BASE is 100%');
  await fn.stepAppScale(-1); await fn.stepAppScale(-1);
  await fn.stepAppScale(null);
  assert.equal(fn.scale, 13);
});

test('every step APPLIES and PERSISTS — a size that resets on relaunch reads as broken', async () => {
  const { fn, calls } = harness();
  await fn.stepAppScale(1);
  assert.deepEqual(calls.applied, [14], 'applied immediately');
  assert.deepEqual(calls.saved, [['appFontSize', 14]], 'and written to the SAME key Settings uses');
});

test('the clamp still reports, with a marker — a silent keypress is the bug being fixed', async () => {
  /* PR #10 exists because a control announced success while doing nothing. The mirror failure is
     a control that goes silent at its limit, leaving the operator pressing a dead key. The
     trailing `·` distinguishes "changed" from "already at the edge" without a second string. */
  const { fn, calls } = harness();
  fn.scale = 18;
  await fn.stepAppScale(1);
  const last = calls.toasts[calls.toasts.length - 1];
  assert.match(last, /pct=138/, 'it still says where you are');
  assert.ok(last.endsWith(' ·'), 'and marks that this press changed nothing');
  calls.toasts.length = 0;
  fn.scale = 13;
  await fn.stepAppScale(1);
  assert.ok(!calls.toasts[0].endsWith(' ·'), 'a real change carries no marker');
});

test('a garbage delta is a no-op, not a NaN scale', async () => {
  /* The intent payload crosses IPC, so `delta` is whatever arrived. `Number(m.delta) || 0` in the
     handler already guards it; this pins that a 0 delta cannot corrupt the stored size. */
  const { fn } = harness();
  await fn.stepAppScale(0);
  assert.equal(fn.scale, 13, 'unchanged and still a number');
});
