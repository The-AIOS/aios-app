/**
 * The running card's account swap: offered at the usage the framework names, never at a number of
 * the App's own. Before, the App never offered it (`showSwap: false`), Glass offered it at 5h 95 /
 * 7d 99 from constants, and the watcher rotated at 98.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readSwapRule, swapOffer } from '../main/swapOffer';
import { parseAvailability } from '../core/accounts';

const ROOT = path.join(__dirname, '..', '..');
const row = (email: string, extra: Record<string, unknown> = {}) => ({
  email, alias: '', plan: '', rotation: true, reason: '', state: 'available', detail: '', ...extra,
});
const NEW = (paused: number | null = null) => ({ rotate_at: { five_hour: 98, seven_day: 98 }, swap_offer_at: { five_hour: 95, seven_day: 95 }, rotation_paused_until: paused });

test('the rule is read from the framework answer; an older answer has none', () => {
  const json = JSON.stringify([row('a@toy.test', { state: 'active', ...NEW() }), row('b@toy.test', NEW())]);
  assert.deepEqual(readSwapRule(json), { offerFiveHour: 95, offerSevenDay: 95, pausedUntil: null });
  assert.equal(parseAvailability(json)?.length, 2, 'the shared parser still reads the same answer');
  assert.equal(readSwapRule(JSON.stringify([row('a@toy.test'), row('b@toy.test')])), null, 'an older framework: no thresholds, no rule');
  assert.equal(readSwapRule(JSON.stringify([row('a@toy.test', NEW()), row('b@toy.test')])), null, 'a row without them is not a rule');
  assert.equal(readSwapRule(JSON.stringify([row('a@toy.test', NEW()), row('b@toy.test', { ...NEW(), swap_offer_at: { five_hour: 90, seven_day: 95 } })])), null, 'rows that disagree are not a rule');
  for (const bad of ['', 'not json', '{}', '[]', JSON.stringify([row('a', { swap_offer_at: { five_hour: 0, seven_day: 95 } })]), JSON.stringify([row('a', { swap_offer_at: { five_hour: '95', seven_day: 95 } })])]) {
    assert.equal(readSwapRule(bad), null, JSON.stringify(bad));
  }
  assert.equal(readSwapRule(JSON.stringify([row('a', NEW(1795820000))]))?.pausedUntil, 1795820000, 'the pause, in epoch seconds');
});

test('the button: at the framework\'s usage, in either window, only with two accounts or more', () => {
  const rule = { offerFiveHour: 95, offerSevenDay: 95, pausedUntil: null };
  const at = (fiveHour: number, sevenDay: number, accounts = 2, next = 'b@toy.test') => swapOffer({ fiveHour, sevenDay, accounts, rule, next });
  assert.equal(at(94, 10).showSwap, false);
  assert.deepEqual(at(95, 10), { showSwap: true, to: 'b@toy.test', pausedUntil: null });
  assert.equal(at(10, 95).showSwap, true, 'the weekly window too, at the same margin (Glass waited for 99)');
  assert.equal(at(99, 99, 1).showSwap, false, 'one account: nothing to swap to');
  assert.deepEqual(at(97, 10, 2, ''), { showSwap: true, to: '', pausedUntil: null }, 'nowhere to go: still shown, saying so');
  assert.deepEqual(swapOffer({ fiveHour: 96, sevenDay: 0, accounts: 2, rule: { ...rule, pausedUntil: 1795820000 }, next: 'b@toy.test' }).pausedUntil, 1795820000, 'paused: shown, with the pause');
  assert.equal(swapOffer({ fiveHour: 100, sevenDay: 100, accounts: 3, rule: null, next: 'b@toy.test' }).showSwap, false, 'an older framework: what the App did before, no button');
});

test('the App holds no threshold of its own, and the card shows what main decides', () => {
  const host = fs.readFileSync(path.join(ROOT, 'src', 'main', 'panelHost.ts'), 'utf8');
  assert.match(host, /const swap = rl \? aios\.swapOfferNow\(rl\.fiveHourPct, rl\.sevenDayPct\) : undefined;/);
  assert.match(host, /showSwap: !!swap\?\.showSwap, to: swap\?\.to \?\? '', pausedUntil: swap\?\.pausedUntil \?\? null/);
  assert.doesNotMatch(host, /showSwap: false, to: '' \}\s*:/, 'the hard-coded "never" is gone');
  for (const f of [path.join('src', 'main', 'swapOffer.ts'), path.join('src', 'main', 'panelHost.ts')]) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8'), />= ?(9[0-9])\b/, `${f}: no usage threshold written in the App`);
  }
  const app = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
  const quota = app.slice(app.indexOf('function buildQuotaRow('), app.indexOf('function buildQuotaRow(') + 3000);
  assert.match(quota, /if \(!q\.showSwap\) return row;/);
  assert.match(quota, /window\.glassShell\.accountsSwap\(q\.to\)/, 'the click goes through the framework switch, like Settings');
  assert.match(quota, /t\('pulse\.noAccount'\)/);
  assert.match(quota, /t\('pulse\.rotationPaused'/);
  assert.match(quota, /b\.disabled = !q\.to \|\| quotaSwapping;/, 'a rebuilt button cannot start a second switch');
  assert.match(quota, /if \(q\.pausedUntil && q\.pausedUntil \* 1000 > Date\.now\(\)\)/, 'an ended pause is not shown');
  const aiosSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'aios.ts'), 'utf8');
  assert.match(aiosSrc, /Date\.now\(\) - swapTriedAt > SWAP_CACHE_MAX_AGE_MS\) \{\s*swapAsking = true;\s*swapTriedAt = Date\.now\(\);/, 'a failing script is asked once a minute, not every tick');
  assert.match(aiosSrc, /if \(ans\.ok\) swapTriedAt = 0;/, 'after a swap the answer is asked again');
});

test('the button\'s words exist in every locale', () => {
  for (const loc of ['en', 'es', 'fr', 'pt-br', 'el']) {
    const m = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'i18n', 'locales', `${loc}.json`), 'utf8'));
    assert.match(m['pulse.swapTo'] ?? '', /\{name\}/, `${loc} pulse.swapTo`);
    assert.ok(m['pulse.noAccount'], `${loc} pulse.noAccount`);
    assert.match(m['pulse.rotationPaused'] ?? '', /\{time\}/, `${loc} pulse.rotationPaused`);
  }
});
