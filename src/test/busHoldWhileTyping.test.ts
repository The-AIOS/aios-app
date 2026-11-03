/**
 * #81 — a bus message is never typed into a prompt the operator is writing (an operator, 26 Oct:
 * "sessions jump in" while he types). The pane reports its operator's keystrokes (renderer
 * noteOperatorKeys, lifted from the source here); the bus holds while operatorComposing says so,
 * inside its own readiness checks and budgets (source invariant below).
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as vm from 'node:vm';
import { operatorComposing, COMPOSE_QUIET_MS, COMPOSE_STALE_MS } from '../main/retypeGuard';

const app = fs.readFileSync('renderer/app.js', 'utf8');
const bus = fs.readFileSync('src/main/commandBus.ts', 'utf8');
const fn = (/const TERM_REPLY = [^\n]+/.exec(app)?.[0] ?? '') + '\n' + (/function noteOperatorKeys\(p, d\) \{[\s\S]*?\n\}/.exec(app)?.[0] ?? '');

function keys() {
  const sent: Array<[string, boolean]> = [];
  const ctx: Record<string, unknown> = {
    window: { glassShell: { busComposing: (n: string, c: boolean) => sent.push([n, c]) } },
    Date: { now: () => 1_000_000 },
  };
  vm.createContext(ctx);
  vm.runInContext(fn + '\nthis.note = noteOperatorKeys;', ctx);
  return { note: ctx.note as (p: object, d: string) => void, sent };
}

test('the renderer helper exists and reports to the bus', () => { assert.ok(fn, 'noteOperatorKeys in renderer/app.js'); });

test('typing is a draft; Enter and Ctrl-C end it; Ctrl-U does not (it may clear only to the cursor)', () => {
  const { note, sent } = keys(); const p: Record<string, unknown> = { name: 'ali' };
  note(p, 'half a sen'); assert.equal(p.composing, true);
  note(p, '\r'); assert.equal(p.composing, false);
  note(p, 'x'); note(p, '\x03'); assert.equal(p.composing, false);
  note(p, 'y'); note(p, '\x1b[D\x1b[D'); note(p, '\x15'); assert.equal(p.composing, true, 'text after the cursor may remain');
  assert.deepEqual(sent[0], ['ali', true]);
});

test('an up-arrow recalls a prompt, so it is a draft', () => {
  const { note } = keys(); const p: Record<string, unknown> = { name: 'a' };
  note(p, '\x1b[A'); assert.equal(p.composing, true);
});

test('a bracketed paste with line breaks stays a draft until a real Enter', () => {
  const { note } = keys(); const p: Record<string, unknown> = { name: 'a' };
  note(p, '\x1b[200~line one\rline two\r\x1b[201~'); assert.equal(p.composing, true);
  note(p, '\x1b[200~split'); note(p, ' paste\r'); assert.equal(p.composing, true, 'still inside the paste');
  note(p, '\x1b[201~'); note(p, '\r'); assert.equal(p.composing, false);
});

test('text after the last Enter in one chunk is a new draft', () => {
  const { note } = keys(); const p: Record<string, unknown> = { name: 'a' };
  note(p, 'sent\rnext'); assert.equal(p.composing, true);
});

test('the bus holds while composing or within the quiet window, and not otherwise', () => {
  assert.equal(operatorComposing(undefined, 0), false);
  assert.equal(operatorComposing({ composing: true, at: 0 }, 2 * 60_000), true, "a draft paused 2 min still holds (the 3-min cutoff is pinned below)");
  assert.equal(operatorComposing({ composing: false, at: 0 }, COMPOSE_QUIET_MS - 1), true);
  assert.equal(operatorComposing({ composing: false, at: 0 }, COMPOSE_QUIET_MS), false);
});

test('the hold sits in the bus loop, before every type, and gives up under the hold budget', () => {
  const at = bus.indexOf('if (operatorComposing(composing.get(sessionKey(req.name)), Date.now(), composeStaleMs(stash)))');
  assert.ok(at > 0, 'runSend checks composing');
  assert.ok(at < bus.indexOf("emit(win(), 'sendByName'"), 'before it types');
  assert.match(bus.slice(at, at + 600), /MAX_HOLD_MS[\s\S]*markUndelivered/);
  assert.doesNotMatch(app, /holdBusSend/, 'the renderer never types a held message on its own');
});

test('the pane re-checks with no gap and the bus keeps the request without spending an attempt', () => {
  const send = /case 'sendByName': \{[\s\S]*?\n    \}/.exec(app)?.[0] ?? '';
  assert.ok(send.indexOf('BUS_DEFERRED_TYPING') > 0 && send.indexOf('BUS_DEFERRED_TYPING') < send.indexOf('submitToPty'));
  const r = /const BUS_DEFERRED_TYPING = '([^']+)'/.exec(app)?.[1];
  const m = /const DEFERRED_TYPING = '([^']+)'/.exec(bus)?.[1];
  assert.ok(r && r === m, 'renderer and bus agree on the deferred reason');
  const branch = bus.slice(bus.indexOf('sendResult.reason === DEFERRED_TYPING'), bus.indexOf('if (releaseForSibling'));
  assert.match(branch, /attempts--/);
  assert.doesNotMatch(branch, /markUndelivered|releaseForSibling/);
});

test('a dropped path counts as a draft', () => {
  // the pty branch notes the draft before it writes; a chat-view drop goes to the composer instead (chatDrop.test.ts)
  assert.match(app, /attachDropZone\(el, \(paths\) => \{\n[^\n]*chatSkinTakeDrop[^\n]*\n\s*noteOperatorKeys\(p, 'drop'\); window\.glassShell\.ptyWrite/);
});

test('a deferral is a timed hold: it never latches a draft the pane did not report', () => {
  const branch = bus.slice(bus.indexOf('sendResult.reason === DEFERRED_TYPING'), bus.indexOf('if (releaseForSibling'));
  assert.match(branch, /composing: !!prev && prev\.composing, at: prev && prev\.composing \? prev\.at : Date\.now\(\)/);
  assert.doesNotMatch(branch, /composing: true/);
});

test('a deferral never restarts a reported draft\'s clock — the hold is 3 min, not 6 (0.13.0 round)', () => {
  const branch = bus.slice(bus.indexOf('sendResult.reason === DEFERRED_TYPING'), bus.indexOf('if (releaseForSibling'));
  assert.doesNotMatch(branch, /prev\.composing, at: Date\.now\(\) \}/);
});

test('a stale draft is stashed (Ctrl+S) before the message is typed, never glued to it (0.13.0 round)', () => {
  const send = /case 'sendByName': \{[\s\S]*?\n    \}/.exec(app)?.[0] ?? '';
  const stash = send.indexOf("if (p.composing && m.stash) { window.glassShell.ptyWrite(hit[0], '\\x13');");
  assert.ok(stash > 0, 'the stash is sent when the pane holds a draft');
  assert.ok(stash > send.indexOf('BUS_DEFERRED_TYPING') && stash < send.indexOf('submitToPty'), 'after the hold, before the type');
});

test('ESC-Enter (a new line inside the draft) does not end it', () => {
  const { note } = keys(); const p: Record<string, unknown> = { name: 'a' };
  note(p, 'line one'); note(p, '\x1b\r'); assert.equal(p.composing, true);
});

test('a draft report goes stale; an ended pane clears its draft', () => {
  assert.equal(operatorComposing({ composing: true, at: 0 }, COMPOSE_STALE_MS - 1), true);
  assert.equal(operatorComposing({ composing: true, at: 0 }, COMPOSE_STALE_MS), false);
  assert.match(app, /p\.exited = true; if \(p\.composing && p\.name\) \{ p\.composing = false; window\.glassShell\.busComposing\(p\.name, false\); \}/);
});

test('an earlier copy that landed is found before any draft hold or its timeout', () => {
  assert.ok(bus.indexOf('landedBeforeRetype(!!firstTypedAt') < bus.indexOf('if (operatorComposing(composing.get'));
});

test('terminal replies (focus, cursor position, device attributes, mouse) never make a draft', () => {
  const { note } = keys(); const p: Record<string, unknown> = { name: 'a' };
  for (const r of ['\x1b[I', '\x1b[O', '\x1b[12;40R', '\x1b[?1;2c', '\x1b[>0;10;1c', '\x1b]11;rgb:0000/0000/0000\x07', '\x1b[<0;10;5M', '\x1b[?2004;1$y']) {
    note(p, r);
    assert.notEqual(p.composing, true, JSON.stringify(r));
  }
  assert.equal(p.lastKeyAt, undefined, 'and they do not count as a key');
  note(p, 'x'); assert.equal(p.composing, true);
});

test('an abandoned draft stops holding after 3 min — in the pane AND the bus, the same limit', async () => {
  /* A lone Esc, Shift-Tab or digit leaves "composing" set with no Enter to clear it. Unbounded, that
     held the session's messages up to the queue's 24 h ceiling with no log line (0.13.0 review). */
  const fs = await import('fs');
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  assert.equal(COMPOSE_STALE_MS, 3 * 60 * 1000);
  assert.match(app, /const BUS_COMPOSE_STALE_MS = 3 \* 60 \* 1000;/);
  assert.match(app, /const staleMs = Number\(m\.staleMs\) > 0 \? Number\(m\.staleMs\) : BUS_COMPOSE_STALE_MS;/, 'the pane falls back to 3 min');
  assert.match(app, /if \(\(p\.composing && sinceKey < staleMs\) \|\| sinceKey < 8000\) \{/, 'the pane honours the limit the bus sends');
  assert.equal(operatorComposing({ composing: true, at: 0 }, 3 * 60 * 1000 + 1), false, 'past 3 min with no key, the bus may type');
  const bus = fs.readFileSync('src/main/commandBus.ts', 'utf8');
  assert.match(bus, /if \(!heldForDraft\) \{ heldForDraft = true; log\(/, 'a draft hold is logged once per request');
});

test('with the prompt stash the draft limit is 10 s; without it (or no version) 3 min and no Ctrl+S', async () => {
  const g = await import('../main/retypeGuard');
  assert.equal(g.hasPromptStash('2.1.312'), true);
  assert.equal(g.hasPromptStash('2.1.69'), true);
  assert.equal(g.hasPromptStash('2.1.68'), false);
  assert.equal(g.hasPromptStash('2.0.99'), false);
  assert.equal(g.hasPromptStash('3.0.0'), true);
  assert.equal(g.hasPromptStash(undefined), false);
  assert.equal(g.hasPromptStash('garbage'), false);
  assert.equal(g.composeStaleMs(true), 10_000);
  assert.equal(g.composeStaleMs(false), 3 * 60 * 1000);
  assert.equal(g.operatorComposing({ composing: true, at: 0 }, 9_999, g.composeStaleMs(true)), true, 'still writing at 9.9 s');
  assert.equal(g.operatorComposing({ composing: true, at: 0 }, 10_000, g.composeStaleMs(true)), false, 'set aside at 10 s');
  assert.equal(g.operatorComposing({ composing: true, at: 0 }, 10_000), true, 'the default is still 3 min');
  assert.match(bus, /const stash = hasPromptStash\(target\?\.version\);/);
  assert.match(bus, /emit\(win\(\), 'sendByName', \{ name: req\.name, text: deliverText, stash, staleMs: composeStaleMs\(stash\) \}\);/);
});
