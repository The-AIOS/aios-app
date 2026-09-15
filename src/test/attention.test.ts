/**
 * The attention counter (#22) — sessions blocked on the operator.
 *
 * ONE counter, not two. The design also carried "finished while you were away", which sounds
 * useful and is not: a Dock badge reading 4 beside two waiting sessions cannot be read, because
 * the halves clear by different acts and neither is visible in the total. The operator ran it
 * and said exactly that. The question underneath — *how do you clear a finished one* — has no
 * good answer, because a result you have not read is not something you can act on. So the badge
 * counts what you can act on, and clears when you act.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import {
  attentionTick, markNotified, badgeText, mayBanner, normalizeNotifyLevel, sessionKey,
  BLOCKED_STATUS_RE, isBlockedStatus,
  EMPTY_ATTENTION, NOTIFY_DEFAULT, type AttentionSession, type AttentionState,
} from '../core/attention';
/* TYPE-ONLY, so it is erased at compile time and never pulls `electron` in at require time —
   the runtime copy comes from loadAttention() below, with the loader stubbed. */
import type { Attention as AttentionClass, AttentionHooks, overlayText as OverlayTextFn, shouldFlash as ShouldFlashFn } from '../main/attention';
import type { RunningAgent } from '../main/aios';

/**
 * Load `main/attention` with `electron` and `../i18n` stubbed, so the class can be DRIVEN.
 *
 * The file needs a display to do its job, which is why this suite historically read it as text.
 * But its interesting behaviour is the bookkeeping around the OS's answer — what is remembered,
 * what is written down, what a later run sees — and none of that needs a display, only a
 * Notification that lets the test decide the verdict. Swapping two modules in the loader buys
 * assertions about the thing itself instead of assertions about how it is spelled.
 */
function loadAttention(): { Attention: new (h: AttentionHooks) => AttentionClass; overlayText: typeof OverlayTextFn; shouldFlash: typeof ShouldFlashFn; lastBanner: () => FakeNotification | undefined; clearBanner: () => void } {
  const Module = require('module') as { _load(req: string, parent: unknown, isMain: boolean): unknown };
  const holder: { last?: FakeNotification } = {};

  class Fake {
    private handlers = new Map<string, ((...a: unknown[]) => void)[]>();
    constructor(_opts: unknown) { holder.last = this as unknown as FakeNotification; }
    on(ev: string, fn: (...a: unknown[]) => void): this {
      this.handlers.set(ev, [...(this.handlers.get(ev) ?? []), fn]); return this;
    }
    show(): void { /* the TEST decides the outcome, by emitting */ }
    emit(ev: string, ...args: unknown[]): void { for (const fn of this.handlers.get(ev) ?? []) fn(...args); }
  }
  const electronStub = {
    app: { setBadgeCount: () => { } },
    Notification: Object.assign(Fake, { isSupported: () => true }),
  };

  const orig = Module._load;
  Module._load = function (this: unknown, req: string, parent: unknown, isMain: boolean): unknown {
    if (req === 'electron') return electronStub;
    return orig.call(this, req, parent, isMain);
  } as typeof Module._load;
  try {
    /* Resolved fresh so the stub is what the module closes over, whatever ran before it. */
    const id = require.resolve('../main/attention');
    delete require.cache[id];
    const mod = require('../main/attention') as { Attention: new (h: AttentionHooks) => AttentionClass;
      overlayText: typeof OverlayTextFn; shouldFlash: typeof ShouldFlashFn };
    delete require.cache[id];   // never leave a stubbed copy for another suite
    return {
      Attention: mod.Attention,
      overlayText: mod.overlayText,
      shouldFlash: mod.shouldFlash,
      /* Read through a CALL, never a property: a test that assigns `holder.last = undefined` to
         reset between cases narrows the property to `undefined` for the rest of the function, and
         the next `.emit()` fails to compile on a value that is perfectly fine at runtime. */
      lastBanner: () => holder.last,
      clearBanner: () => { holder.last = undefined; },
    };
  } finally { Module._load = orig; }
}

interface FakeNotification { emit(ev: string, ...args: unknown[]): void }

/* The Windows taskbar surfaces, silenced. Every case that is not ABOUT them supplies these, so a
   new hook cannot be added without every caller acknowledging it — which is the point of the
   interface being explicit rather than optional. */
const NOOP_WIN = { setOverlay: () => { }, flash: () => { }, isFocused: () => true };

/* `id` defaults to the name because most cases here have one session per name; the duplicate
   tests pass it explicitly, which is the whole reason the field exists. */
const S = (name: string, status: string, waitingFor?: string, id?: string): AttentionSession =>
  ({ id: id ?? name, name, status, ...(waitingFor ? { waitingFor } : {}) });

function run(steps: { sessions: AttentionSession[]; deliver?: boolean }[]) {
  let state: AttentionState = EMPTY_ATTENTION;
  const ticks = [];
  for (const s of steps) {
    const t = attentionTick(state, s.sessions);
    state = s.deliver === false ? t.state : markNotified(t.state, t.pending.map((p) => p.id));
    ticks.push(t);
  }
  return ticks;
}

test('the badge counts blocked sessions, and only those', () => {
  const t = run([{ sessions: [S('a', 'waiting', 'permission'), S('b', 'busy'), S('c', 'idle'), S('d', 'shell')] }]);
  assert.equal(t[0].badge, 1, 'busy, idle and a shell are not waiting on anybody');
  assert.deepEqual(t[0].blocks.map((b) => b.name), ['a']);
});

test('answering is what clears it — and it is the only thing that does', () => {
  const t = run([
    { sessions: [S('writer', 'waiting', 'input needed')] },
    { sessions: [S('writer', 'waiting', 'input needed')] },   // still sitting there
    { sessions: [S('writer', 'busy')] },                      // answered
  ]);
  assert.equal(t[1].badge, 1, 'time passing does not resolve a question');
  assert.equal(t[2].badge, 0);
});

test('a block banners once on entry, not once per poll', () => {
  const blocked = [S('writer', 'waiting', 'input needed')];
  const t = run([{ sessions: blocked }, { sessions: blocked }, { sessions: blocked }]);
  assert.deepEqual(t[0].pending.map((p) => p.name), ['writer'], 'entering the state speaks');
  assert.deepEqual(t[1].pending, [], 'the same unresolved block is not news again');
  assert.deepEqual(t[2].pending, [], 'and still is not, however long it sits');
  assert.equal(t[2].badge, 1, 'but it keeps its badge while it blocks');
});

test('a second block on the same session, once the first was answered, speaks again', () => {
  const t = run([
    { sessions: [S('writer', 'waiting', 'permission')] },
    { sessions: [S('writer', 'busy')] },
    { sessions: [S('writer', 'waiting', 'another one')] },
  ]);
  assert.deepEqual(t[2].pending.map((p) => p.name), ['writer'], 'a NEW block is new news');
});

test('a banner the OS refused is retried, never silently marked as shown', () => {
  const blocked = [S('writer', 'waiting', 'input needed')];
  let state = EMPTY_ATTENTION;
  const first = attentionTick(state, blocked);
  assert.deepEqual(first.pending.map((p) => p.name), ['writer']);
  state = first.state;                                   // notifier failed — nothing marked
  const second = attentionTick(state, blocked);
  assert.deepEqual(second.pending.map((p) => p.name), ['writer'],
    'detected is not accepted: a failed notification leaves the block pending');
  state = markNotified(second.state, ['writer']);
  assert.deepEqual(attentionTick(state, blocked).pending, [], 'and now it rests');
});

test('a session that ends takes its count with it', () => {
  const t = run([
    { sessions: [S('a', 'waiting', 'q'), S('b', 'waiting', 'q')] },
    { sessions: [S('a', 'waiting', 'q')] },
  ]);
  assert.equal(t[0].badge, 2);
  assert.equal(t[1].badge, 1, 'a session that no longer exists cannot still be waiting on you');
});

test('TWO SESSIONS, ONE NAME: counted separately, never collapsed', () => {
  /* Nothing enforces unique names — the registry is one file per PID, so `spawn ingest` twice
     gives two live sessions called `ingest`. Keyed on name they merged silently. */
  const t = run([{ sessions: [S('ingest', 'waiting', 'q1', 'sid-a'), S('ingest', 'idle', undefined, 'sid-b')] }]);
  assert.equal(t[0].badge, 1, 'only one of them is blocked');
  assert.equal(t[0].blocks[0].id, 'sid-a', 'and we know which');
});

test('a banner for one namesake does not silence the other', () => {
  const t = run([
    { sessions: [S('ingest', 'waiting', 'q1', 'sid-a'), S('ingest', 'busy', undefined, 'sid-b')] },
    { sessions: [S('ingest', 'waiting', 'q1', 'sid-a'), S('ingest', 'waiting', 'q2', 'sid-b')] },
  ]);
  assert.deepEqual(t[0].pending.map((p) => p.id), ['sid-a']);
  assert.deepEqual(t[1].pending.map((p) => p.id), ['sid-b'], 'the second blocking is its own news');
});

test('sessionKey prefers sessionId and falls back to the pid, never to the name', () => {
  assert.equal(sessionKey({ sessionId: 'abc', pid: 5 }), 'abc');
  assert.equal(sessionKey({ sessionId: '', pid: 5 }), 'pid:5', 'a record with no id is still unique');
  assert.equal(sessionKey({ sessionId: '   ', pid: 7 }), 'pid:7', 'whitespace is not an id');
  assert.notEqual(sessionKey({ sessionId: '', pid: 1 }), sessionKey({ sessionId: '', pid: 2 }));
});

test('levels: off shows nothing, badge never banners, banner does both', () => {
  assert.equal(badgeText(3, 'off'), '', 'off is genuinely off — no badge either');
  assert.equal(badgeText(3, 'badge'), '3');
  assert.equal(badgeText(0, 'banner'), '', 'zero clears the badge rather than showing a 0');
  assert.equal(mayBanner('badge'), false, 'badge-only is the point of the middle rung');
  assert.equal(mayBanner('banner'), true);
});

test('an unknown or absent level falls back to telling the operator', () => {
  assert.equal(NOTIFY_DEFAULT, 'banner');
  assert.equal(normalizeNotifyLevel(undefined), 'banner');
  assert.equal(normalizeNotifyLevel('nonsense'), 'banner');
  assert.equal(normalizeNotifyLevel(' BADGE '), 'badge', 'case and whitespace are not a preference');
  assert.equal(normalizeNotifyLevel('off'), 'off', 'but a real choice is honoured');
});

test('the counter and the coloured dot answer the SAME question, character for character', () => {
  /* THE BUG THIS EXISTS FOR, reported from a signed build: a session showed the blue "needs you"
     dot and produced no badge and no banner at all. The dot ran a regex; the counter demanded
     `status === 'waiting'`. Two predicates for one question, so the surface that colours and the
     surface that counts disagreed — and the disagreement is invisible, because each is correct
     on its own terms.

     The renderer is plain `.js` and cannot import this module, so the two spellings are pinned
     to each other here instead. If either moves, this fails and names the other. */
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'app.js'), 'utf8');
  const inRenderer = src.match(/if \((\/[^\n]+?\/)\.test\(st\)\) return \{ cls: 'input'/);
  assert.ok(inRenderer, "statusInfo's needs-input test not found — it moved, and this pin is now blind");
  assert.equal(inRenderer[1], String(BLOCKED_STATUS_RE),
    'the renderer decides the blue dot with a different expression than the badge counts with. '
    + 'They must be identical: a dot without a badge is what the operator actually saw.');
});

test('the shared predicate accepts what Claude Code actually writes', () => {
  for (const s of ['waiting', 'waiting for input', 'needs permission approval', 'blocked', 'input needed']) {
    assert.equal(isBlockedStatus(s), true, `"${s}" is a session waiting on you`);
  }
  for (const s of ['busy', 'idle', 'shell', '']) {
    assert.equal(isBlockedStatus(s), false, `"${s}" is not`);
  }
});

test('ONE banner per block, whatever the OS reports back — including nothing at all', () => {
  /* The bound used to live entirely inside the `failed` handler, which assumed the OS always
     answers. Operator-reported 2026-09-15: with notifications revoked in system settings, a
     signed build got neither `show` nor `failed`. Two things followed, and only the first was
     noticed — no banner and no explanation; but the block also stayed PENDING, so the 2s poll
     built a fresh notification every tick for as long as that session stayed blocked.
     A retry budget keyed on a verdict cannot bound the case where no verdict arrives. So the
     block is marked when we ASK, which is the only thing we actually observe, and un-marked only
     if the OS comes back to say it failed. */
  const { Attention, lastBanner } = loadAttention();
  const blocked = [{ name: 'ingest', status: 'waiting', pid: 4242, sessionId: 'sid-1' } as RunningAgent];
  let banners = 0;
  const a = new Attention({ ...NOOP_WIN, reveal: () => { }, notifyBlocked: () => { } });

  /* THE SILENT OS: tick repeatedly and never emit anything back. */
  for (let i = 0; i < 20; i++) {
    const before = lastBanner();
    a.tick(blocked, 'banner');
    if (lastBanner() !== before) banners++;
  }
  assert.equal(banners, 1,
    'twenty ticks, one notification — silence must not read as "not yet delivered"');

  /* A REFUSAL IS DIFFERENT: it is a real answer, so it earns a bounded retry. */
  const b = new Attention({ ...NOOP_WIN, reveal: () => { }, notifyBlocked: () => { } });
  let tries = 0;
  for (let i = 0; i < 20; i++) {
    const before = lastBanner();
    b.tick(blocked, 'banner');
    const now = lastBanner();
    if (now !== before) { tries++; now?.emit('failed', {}, 'UNErrorDomain error 1'); }
  }
  assert.equal(tries, 3, 'three attempts, then it stops — not once, and not forever');

  /* AND A SUCCESS IS FINAL. */
  const c = new Attention({ ...NOOP_WIN, reveal: () => { }, notifyBlocked: () => { } });
  let shown = 0;
  for (let i = 0; i < 20; i++) {
    const before = lastBanner();
    c.tick(blocked, 'banner');
    const now = lastBanner();
    if (now !== before) { shown++; now?.emit('show', {}); }
  }
  assert.equal(shown, 1, 'a delivered banner is never sent twice');
});

test('WINDOWS: the count reaches a taskbar that has no badge, and the flash is bounded', () => {
  /* `app.setBadgeCount` is a silent no-op on Windows, so every count this feature produces
     reached a Windows operator NOWHERE. The taskbar equivalents are an overlay glyph and
     flashing the button. Neither API can be exercised on the machine this was written on, which
     is exactly why the DECISIONS are separated from the calls: an untestable API wrapped around
     an untested decision is two unknowns, and only one of them has to stay unknown. */
  const { overlayText, shouldFlash } = loadAttention();

  assert.equal(overlayText(0, 'banner'), '', 'nothing waiting → the overlay is cleared, not blank-drawn');
  assert.equal(overlayText(3, 'banner'), '3');
  assert.equal(overlayText(3, 'badge'), '3', 'the count is not a banner — badge level still shows it');
  assert.equal(overlayText(3, 'off'), '', 'off means off on every surface');
  assert.equal(overlayText(9, 'banner'), '9');
  assert.equal(overlayText(10, 'banner'), '9+', 'two characters is all a 16px overlay can hold');
  assert.equal(overlayText(999, 'banner'), '9+');

  /* Flashing at someone already looking at the app is shouting in a quiet room — and on Windows
     the flash persists until the window is ACTIVATED, so one raised while focused could never
     clear itself. */
  assert.equal(shouldFlash(1, false, 'banner'), true, 'something new, and they are looking elsewhere');
  assert.equal(shouldFlash(1, true, 'banner'), false, 'focused — they can already see it');
  assert.equal(shouldFlash(0, false, 'banner'), false, 'nothing NEW; an hour-old block must not re-flash');
  assert.equal(shouldFlash(1, false, 'off'), false);
  assert.equal(shouldFlash(1, false, 'badge'), true, 'a badge-level operator still gets the taskbar cue');
});

test('WINDOWS: the taskbar surfaces are driven, cleared on dispose, and platform-guarded', () => {
  const { Attention } = loadAttention();
  const calls: string[] = [];
  const a = new Attention({
    ...NOOP_WIN, reveal: () => { }, notifyBlocked: () => { },
    setOverlay: (text: string) => { calls.push('overlay:' + text); },
    flash: (on: boolean) => { calls.push('flash:' + String(on)); },
    isFocused: () => false,
  });

  a.tick([{ name: 'ingest', status: 'waiting', pid: 1, sessionId: 's1' } as RunningAgent], 'badge');
  assert.ok(calls.includes('overlay:1'), 'the count reaches the overlay');
  assert.ok(calls.includes('flash:true'), 'and an unfocused window is flashed');

  /* ONLY ON A CHANGE. Redrawing an overlay every two seconds is the class of defect AI-157 was;
     the flash is worse, because re-raising it restarts the attention cycle. */
  const n = calls.length;
  a.tick([{ name: 'ingest', status: 'waiting', pid: 1, sessionId: 's1' } as RunningAgent], 'badge');
  assert.equal(calls.length, n, 'an unchanged tick touches neither surface');

  a.dispose();
  assert.equal(calls.at(-2), 'overlay:', 'a taskbar overlay outlives its window unless cleared');
  assert.equal(calls.at(-1), 'flash:false', 'and a flashing button nothing can stop is worse than no signal');

  /* The calls themselves are guarded by PLATFORM, not by feature-detection: setOverlayIcon is on
     the BrowserWindow type everywhere and documented Windows-only, so a truthy check says yes on
     macOS and then does nothing — a call that reads as wired and is not. */
  const host = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'panelHost.ts'), 'utf8');
  for (const fn of ['setOverlay', 'flash']) {
    const i = host.indexOf(fn + ': (');
    assert.notEqual(i, -1, fn + ' must be wired');
    assert.match(host.slice(i, i + 220), /process\.platform !== 'win32'\) return;/,
      fn + ' must be platform-guarded');
  }
  /* Windows drops a toast whose id does not match the Start Menu shortcut, silently. */
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'main.ts'), 'utf8');
  assert.match(main, /app\.setAppUserModelId\(APP_ID\)/, 'toasts need an AppUserModelID on Windows');
  /* THE ID IN THE CODE MUST EQUAL THE ONE THE INSTALLER WRITES. electron-builder rewrites
     package.json when it packages and drops the `build` block, so this cannot be read at runtime
     — the first version tried, got undefined in the shipped app, and fell through to a literal
     that happened to be right. Change build.appId and Windows would drop every toast, silently,
     with the packaged app announcing the old id. So the literal is checked against the source of
     truth here, where a mismatch is loud. */
  const declared = /const APP_ID = '([^']+)'/.exec(main);
  assert.ok(declared, 'APP_ID must be a literal — a runtime read does not survive packaging');
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')) as
    { build?: { appId?: string } };
  assert.equal(declared[1], pkg.build?.appId,
    'APP_ID and build.appId disagree — the installer writes build.appId onto the Start Menu '
    + 'shortcut, and Windows drops any toast whose id does not match it');
});

test('clicking a banner focuses the WAITING SESSION, in the shape the renderer can resolve', () => {
  /* The banner used to send `{ pid }`. The renderer resolves a pane by `sessionId`, falling back
     to `name`, and has no pid index at all — a pane object never stores one. So the click raised
     the window and then toasted "isn't a pane in this window", which is the opposite of the one
     thing a notification click is for.
     It survived three rounds of testing because the only machine exercising it had two installed
     bundles: the banner was activating the OTHER one, so this code never ran. A bug can hide
     behind a second bug that was explicitly scoped out. */
  const { Attention, lastBanner } = loadAttention();
  const revealed: { name: string; sessionId?: string }[] = [];
  const a = new Attention({ ...NOOP_WIN, reveal: (t) => { revealed.push(t); }, notifyBlocked: () => { } });

  a.tick([{ name: 'ingest', status: 'waiting', pid: 4242, sessionId: 'sid-abc' } as RunningAgent], 'banner');
  lastBanner()?.emit('click', {});

  assert.deepEqual(revealed, [{ name: 'ingest', sessionId: 'sid-abc' }],
    'identity, not a pid — and the id is what disambiguates two sessions sharing a name');

  /* The payload must match what the renderer's handler actually reads. Asserted against the
     renderer source, because these two are wired by convention and nothing else checks them. */
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'renderer', 'app.js'), 'utf8');
  assert.match(app, /case 'focusTerminal':[\s\S]{0,400}?byName\(m\.name, m\.id\)/,
    'the handler resolves by name + id, so those are the keys the intent must carry');
  const host = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'panelHost.ts'), 'utf8');
  assert.match(host, /this\.intent\('focusTerminal', \{ name: target\.name, id: target\.sessionId/,
    'and the intent sends exactly those keys');
});

test('the permission requirement is stated in the SETTING, not left to be discovered', () => {
  /* Three rounds of testing on a signed build produced no runtime warning of any kind, because
     both the in-app warning and the toast hung off a `failed` event the OS never sent. A warning
     that cannot be shown to fire is worse than none: it reads as a feature and is a blank.
     So the requirement is stated where the choice is made, unconditionally, in prose that does
     not depend on detecting anything — and the text stays platform-neutral, because this ships
     to three of them and naming one makes it wrong on the other two. */
  const en = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'i18n', 'locales', 'en.json'), 'utf8')) as Record<string, string>;

  for (const key of ['settings.attentionHint', 'whatsnew.b2']) {
    const copy = en[key];
    assert.ok(copy, `${key} must exist`);
    assert.match(copy, /permission/i, `${key}: say that permission is required`);
    assert.match(copy, /operating system/i, `${key}: name where it is granted`);
    assert.doesNotMatch(copy, /\bmacOS\b|\bWindows\b|\bDock\b|System Settings/,
      `${key}: platform-neutral — this ships to three platforms`);
  }
  /* The hint no longer points at push settings that are not in this panel. */
  assert.doesNotMatch(en['settings.attentionHint'], /phone/i,
    'the hint described phone push settings that do not exist in this panel');
});
