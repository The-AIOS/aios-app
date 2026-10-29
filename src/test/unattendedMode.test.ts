/**
 * Unattended mode — a machine nobody is sitting at reopens with every session running.
 *
 * Two things stopped such a machine after a reopen: the "Reopen last sessions?" offer waits for a
 * click, and a resumed session can sit on Claude Code's resume question ("Resume from summary" /
 * "Resume this conversation?") forever. The mode answers both, and only when switched on.
 *
 * The detector is tested against what Claude Code ACTUALLY prints. Its renderer does not write the
 * spaces between words — it moves the cursor to each word's column — so a fixture typed as a
 * plain sentence would pass a detector that never matches a real screen. The frames below are
 * built the way a live capture is encoded, and the workspace-trust prompt is a real capture
 * (folder path replaced), kept to prove the mode never answers anything but the resume question.
 *
 * These EXECUTE the real functions out of renderer/app.js (regex + new Function, like
 * sessionRestore.test.ts): the guarantee is about which bytes reach the pty, and only running the
 * code can say that.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

const app = fs.readFileSync('renderer/app.js', 'utf8');
function grab(re: RegExp, what: string): string {
  const m = re.exec(app);
  if (!m) assert.fail(`${what} must be findable in renderer/app.js`);
  return m[0];
}

const CORE = [
  grab(/function unattendedModeOf\(v\) \{[^\n]*\}/, 'unattendedModeOf'),
  grab(/const UNATTENDED_WINDOW_MS = [\s\S]*?\nconst RESUME_QUOTA_DIALOG = [^\n]*\n/, 'the unattended constants'),
  grab(/function ptyPlain\(s\) \{[\s\S]*?\n\}/, 'ptyPlain'),
  grab(/function resumeDialogKeys\(plain, mode\) \{[\s\S]*?\n\}/, 'resumeDialogKeys'),
].join('\n');

type Core = { unattendedModeOf: (v: unknown) => string; ptyPlain: (s: string) => string;
              resumeDialogKeys: (plain: string, mode: string) => string[] | null };
const core: Core = new Function(CORE + '\nreturn { unattendedModeOf, ptyPlain, resumeDialogKeys };')();
const keysFor = (raw: string, mode: string): string[] | null => core.resumeDialogKeys(core.ptyPlain(raw), mode);

/* One screen line the way Claude Code writes it: each word placed with ESC[<col>G, no spaces. */
function inkLine(text: string, col = 2): string {
  let out = '';
  for (const w of text.split(' ')) { out += `\x1b[${col}G${w}`; col += w.length + 1; }
  return out + '\r\r\n';
}
const BLANK = '\r\r\n';
function summaryDialog({ instant = true, focus = 0 } = {}): string {
  const rows = [instant ? 'Resume from summary (instant, recommended)' : 'Resume from summary (recommended)',
                'Resume full session as-is', "Don't ask me again"];
  return '\x1b[38;5;220m────────\x1b[39m\r\r\n'
    + '\x1b[1m' + inkLine('This session is 3h 12m old and 401.5k tokens.') + '\x1b[22m' + BLANK
    + inkLine('Resuming the full session will consume a substantial portion of your usage limits.')
    + inkLine('We recommend resuming from a summary.') + BLANK
    + rows.map((r, i) => (i === focus ? '\x1b[2G\x1b[38;5;153m❯' : '') + inkLine(`${i + 1}. ${r}`, 4)).join('')
    + BLANK + '\x1b[38;5;246m' + inkLine('Enter to confirm · Esc to cancel') + '\x1b[39m';
}
function quotaDialog({ focus = 0 } = {}): string {
  const rows = ['Resume', 'Start a new conversation'];
  return '\x1b[38;5;220m' + inkLine('Resume this conversation?') + '\x1b[39m' + BLANK
    + inkLine('This conversation has been inactive for 2 hours and is 401.5k tokens long.')
    + inkLine('Resuming it will use about 6% of your 5-hour usage limit.') + BLANK
    + rows.map((r, i) => (i === focus ? '\x1b[2G\x1b[38;5;153m❯' : '') + inkLine(`${i + 1}. ${r}`, 4)).join('')
    + BLANK + inkLine('Enter to confirm · Esc to resume');
}
/* A REAL capture: `claude` started in a folder it does not trust (path replaced). */
const TRUST_CAPTURE = [
  '\x1b7\x1b[r\x1b8\x1b[?25h\x1b[?25l\x1b[?2004h\x1b[?2031h\x1b[?1004h\r\r\n',
  '\x1b[38;5;220m────────\x1b[39m\r\r\n',
  '\x1b[2G\x1b[38;5;220m\x1b[1mAccessing\x1b[12Gworkspace:\x1b[22m\x1b[39m\r\r\n',
  '\r\r\n',
  '\x1b[2G\x1b[1m/tmp/untrusted-folder\x1b[22m\r\r\n',
  '\r\r\n',
  '\x1b[2GQuick\x1b[8Gsafety\x1b[15Gcheck:\x1b[22GIs\x1b[25Gthis\x1b[30Ga\x1b[32Gproject\x1b[40Gyou\x1b[44Gcreated\x1b[52Gor\x1b[55Gone\x1b[59Gyou\x1b[63Gtrust?\x1b[70G(Like\x1b[76Gyour\x1b[81Gown\x1b[85Gcode,\x1b[91Ga\x1b[93Gwell-known\x1b[104Gopen\x1b[109Gsource\r\r\n',
  '\x1b[2Gproject,\x1b[11Gor\x1b[14Gwork\x1b[19Gfrom\x1b[24Gyour\x1b[29Gteam).\x1b[36GIf\x1b[39Gnot,\x1b[44Gtake\x1b[49Ga\x1b[51Gmoment\x1b[58Gto\x1b[61Greview\x1b[68Gwhat\'s\x1b[75Gin\x1b[78Gthis\x1b[83Gfolder\x1b[90Gfirst.\r\r\n',
  '\r\r\n',
  '\x1b[2GClaude\x1b[9GCode\'ll\x1b[17Gbe\x1b[20Gable\x1b[25Gto\x1b[28Gread,\x1b[34Gedit,\x1b[40Gand\x1b[44Gexecute\x1b[52Gfiles\x1b[58Ghere.\r\r\n',
  '\r\r\n',
  '\x1b[2G\x1b[38;5;246mSecurity\x1b[11Gguide\x1b[39m\r\r\n',
  '\r\r\n',
  '\x1b[2G\x1b[38;5;153m❯\x1b[4GNo,\x1b[8Gexit\x1b[39m\r\r\n',
  '\x1b[4GYes,\x1b[9GI\x1b[11Gtrust\x1b[17Gthis\x1b[22Gfolder\r\r\n',
  '\r\r\n',
  '\x1b[2G\x1b[38;5;246mEnter\x1b[8Gto\x1b[11Gconfirm\x1b[19G·\x1b[21GEsc\x1b[25Gto\x1b[28Gcancel\x1b[39m\r\r\n',
  '\x1b[1C\x1b[4A\x1b[>0q\x1b[?u\x1b]7501;?\x07\x1b[c',
].join('');

test('the mode is off unless a known value says otherwise', () => {
  for (const v of [null, undefined, '', 'on', 'yes', 'SUMMARY', 'never']) assert.equal(core.unattendedModeOf(v), 'off');
  assert.equal(core.unattendedModeOf('summary'), 'summary');
  assert.equal(core.unattendedModeOf('full'), 'full');
});

test('the words of a real screen only exist once the cursor moves are gone', () => {
  const plain = core.ptyPlain(TRUST_CAPTURE);
  assert.ok(plain.includes('Isthisaprojectyoucreatedoroneyoutrust?'), plain);
  assert.ok(!/\x1b/.test(plain), 'no escape survives');
  /* The control: stripping escapes but keeping their absence of spaces is exactly why a
     sentence-shaped needle can never match. */
  assert.ok(!TRUST_CAPTURE.replace(/\x1b\[[0-9;?>]*[A-Za-z]/g, '').includes('Is this a project'));
});

test('summary mode takes the focused first row of the summary question — Enter, nothing else', () => {
  assert.deepEqual(keysFor(summaryDialog(), 'summary'), ['\r']);
  assert.deepEqual(keysFor(summaryDialog({ instant: false }), 'summary'), ['\r'], 'both wordings of the first row');
});

test('full mode takes the second row — one Down, then Enter; "Don\'t ask me again" is never reached', () => {
  assert.deepEqual(keysFor(summaryDialog(), 'full'), ['\x1b[B', '\r']);
  for (const mode of ['summary', 'full']) {
    const k = keysFor(summaryDialog(), mode) ?? [];
    assert.ok(k.filter((x) => x === '\x1b[B').length < 2, 'two Downs would land on the row that writes a global flag');
  }
});

test('the quota question is answered with Esc in both modes, whichever row has the focus', () => {
  /* Enter is not safe here: Claude Code can put the focus on "Start a new conversation". Esc is
     "dismiss", which keeps the resumed conversation. */
  for (const mode of ['summary', 'full']) {
    assert.deepEqual(keysFor(quotaDialog(), mode), ['\x1b']);
    assert.deepEqual(keysFor(quotaDialog({ focus: 1 }), mode), ['\x1b']);
  }
});

test('off answers nothing', () => {
  assert.equal(keysFor(summaryDialog(), 'off'), null);
  assert.equal(keysFor(quotaDialog(), 'off'), null);
});

test('the workspace-trust prompt (a real capture) is never answered', () => {
  for (const mode of ['summary', 'full', 'off']) assert.equal(keysFor(TRUST_CAPTURE, mode), null);
});

test('a summary question whose focus is not on the first row is left alone', () => {
  /* Enter or Down+Enter assume the first row is focused. If it is not, the keys would pick
     something else — so the pattern requires the focus marker on that row. */
  assert.equal(keysFor(summaryDialog({ focus: 1 }), 'summary'), null);
  assert.equal(keysFor(summaryDialog({ focus: 2 }), 'full'), null);
  /* And with no focus marker drawn at all (a renderer change): the keys' assumption is unproven. */
  assert.equal(keysFor(summaryDialog({ focus: -1 }), 'summary'), null);
});

test('a conversation that merely TALKS about the question is not the question', () => {
  /* A resumed transcript is printed on screen before anything else, and a session that worked on
     this very feature carries every one of these words. */
  const prose = inkLine('The dialog says This session is 3h old and 400k tokens. and offers')
    + inkLine('Resume from summary (instant, recommended), Resume full session as-is and')
    + inkLine("Don't ask me again. The other one is Resume this conversation? with Resume")
    + inkLine('and Start a new conversation.');
  for (const mode of ['summary', 'full']) assert.equal(keysFor(prose, mode), null);
});

test('a reworded dialog is left alone — a changed Claude Code fails safe, by doing nothing', () => {
  /* Replaced as ENCODED lines: the sentence itself never occurs in the bytes (see the header). */
  const reworded = summaryDialog().replace(inkLine('2. Resume full session as-is', 4), inkLine('2. Resume everything', 4));
  assert.notEqual(reworded, summaryDialog(), 'the control: the rewording really happened');
  assert.equal(keysFor(reworded, 'summary'), null);
  const quota = quotaDialog().replace(inkLine('2. Start a new conversation', 4), inkLine('2. Begin again', 4));
  assert.notEqual(quota, quotaDialog());
  assert.equal(keysFor(quota, 'full'), null);
});

/* ── the per-tab scanner, executed ─────────────────────────────────────────── */
function scanner(mode: string) {
  const clock = { now: 1_000_000 };
  const timers: Array<{ at: number; fn: () => void }> = [];
  const writes: Array<[number, string]> = [];
  const panes = new Map<number, Record<string, unknown>>();
  const src = [
    CORE,
    grab(/const RESUME_CMD = [\s\S]*?\nfunction dialogOnScreen\(rows\) \{[\s\S]*?\n\}/, 'the screen check'),
    grab(/function unattendedScan\(id, p, data\) \{[\s\S]*?\n\}/, 'unattendedScan'),
    'return unattendedScan;',
  ].join('\n');
  const scan = new Function('panes', 'window', 'setTimeout', 'Date', 'console', 'UNATTENDED', src)(
    panes, { glassShell: { ptyWrite: (id: number, d: string) => writes.push([id, d]) } },
    (fn: () => void, ms: number) => { timers.push({ at: clock.now + ms, fn }); return 0; },
    { now: () => clock.now }, { info: () => { /* */ } }, mode) as (id: number, p: object, d: string) => void;
  const tick = (ms: number) => {
    clock.now += ms;
    /* Until nothing is due: a timer that fires can schedule one that is due already. */
    for (let due = timers.filter((t) => t.at <= clock.now); due.length; due = timers.filter((t) => t.at <= clock.now)) {
      due.sort((a, b) => a.at - b.at);
      for (const t of due) { timers.splice(timers.indexOf(t), 1); t.fn(); }
    }
  };
  const pane = (id: number) => {
    const p = { name: 'worker', bornAt: clock.now, exited: false, term: new FakeTerm() } as Record<string, unknown>;
    panes.set(id, p);
    return p;
  };
  /* What onPtyData does: draw it, then scan until the pane is answered. */
  const feed = (id: number, p: Record<string, unknown>, d: string) => {
    (p.term as FakeTerm).write(d);
    if (!p.uaDone) scan(id, p, d);
  };
  return { clock, tick, writes, pane, feed };
}

/* Just enough of a terminal for the screen check: the cursor moves Ink uses to lay words out
   (ESC[<n>G, CR, LF), every other escape dropped, and a 24-row viewport over what was drawn. */
class FakeTerm {
  rows = 24;
  private raw = '';   // parsed whole on each read, so an escape split across pty chunks stays whole
  write(d: string) { this.raw += d; }
  get buffer() {
    const lines: string[][] = [[]];
    let y = 0, x = 0;
    const re = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[([0-?]*)[ -\/]*([@-~])|\x1b.|[\s\S]/gu;
    for (let m; (m = re.exec(this.raw));) {
      const s = m[0];
      if (m[2] === 'G') x = Math.max(0, Number(m[1] || 1) - 1);
      else if (s === '\r') x = 0;
      else if (s === '\n') { y++; while (lines.length <= y) lines.push([]); }
      else if (s[0] !== '\x1b') lines[y][x++] = s;
    }
    return { active: {
      viewportY: Math.max(0, lines.length - this.rows),
      getLine: (y: number) => lines[y] && { translateToString: () => Array.from(lines[y], (c) => c || ' ').join('').trimEnd() },
    } };
  }
}
/* What a resumed session settles on: its prompt box and status line, below whatever came before. */
const PROMPT_BOX = '\x1b[38;5;246m────────\x1b[39m\r\r\n' + inkLine('❯') + '\x1b[38;5;246m────────\x1b[39m\r\r\n'
  + inkLine('? for shortcuts');

test('a question split across pty chunks is found, answered after the grace, once', () => {
  const s = scanner('summary');
  const p = s.pane(7);
  const frame = summaryDialog();
  for (let i = 0; i < frame.length; i += 37) s.feed(7, p, frame.slice(i, i + 37));
  assert.deepEqual(s.writes, [], 'nothing typed the instant it appears');
  s.tick(1499);
  assert.deepEqual(s.writes, []);
  s.tick(1);
  assert.deepEqual(s.writes, [[7, '\r']]);
  s.feed(7, p, summaryDialog());
  s.tick(5000);
  assert.deepEqual(s.writes, [[7, '\r']], 'one answer per tab, even if the question is drawn again');
});

test('full mode spaces its two keys, Down first', () => {
  const s = scanner('full');
  const p = s.pane(3);
  s.feed(3, p, summaryDialog());
  s.tick(1500); s.tick(300);
  assert.deepEqual(s.writes, [[3, '\x1b[B'], [3, '\r']]);
});

test('a key from a person after the question appeared means it is theirs — nothing is typed', () => {
  const s = scanner('summary');
  const p = s.pane(4);
  s.feed(4, p, quotaDialog());
  s.tick(500);
  p.lastKeyAt = s.clock.now;
  s.tick(2000);
  assert.deepEqual(s.writes, []);
});

test('a tab past its first two minutes is never answered, and stops being scanned', () => {
  const s = scanner('summary');
  const p = s.pane(5);
  s.tick(120_001);
  s.feed(5, p, summaryDialog());
  s.tick(5000);
  assert.deepEqual(s.writes, []);
  assert.equal(p.uaDone, true, 'later output costs nothing');
});

test('a tab that ended before the grace ran out is not typed into', () => {
  const s = scanner('full');
  const p = s.pane(6);
  s.feed(6, p, summaryDialog());
  p.exited = true;
  s.tick(5000);
  assert.deepEqual(s.writes, []);
});

test('history that quotes a question, with the prompt below it, is not answered — and the watch goes on', () => {
  for (const mode of ['summary', 'full']) {
    const s = scanner(mode);
    const p = s.pane(8);
    s.feed(8, p, summaryDialog() + BLANK + inkLine('Sure, here is the dialog you asked about.') + PROMPT_BOX);
    s.tick(5000);
    assert.deepEqual(s.writes, [], `${mode}: Enter or Down+Enter in the prompt would resend a prompt`);
    assert.notEqual(p.uaDone, true, 'a false alarm does not spend the one answer');
    s.feed(8, p, summaryDialog());
    s.tick(1500); s.tick(300);
    assert.equal(s.writes.length, mode === 'full' ? 2 : 1, `${mode}: the real question, drawn later, is still answered`);
  }
});

test('the question going away between the two keys stops the second one', () => {
  const s = scanner('full');
  const p = s.pane(9);
  s.feed(9, p, summaryDialog());
  s.tick(1500);
  assert.deepEqual(s.writes, [[9, '\x1b[B']]);
  s.feed(9, p, PROMPT_BOX);
  s.tick(300);
  assert.deepEqual(s.writes, [[9, '\x1b[B']], 'no Enter once the screen shows something else');
});

test('only tabs started with --resume are watched: no other launch asks the question', () => {
  const RESUME_CMD = new RegExp(/const RESUME_CMD = \/(.*)\/;/.exec(app)![1]);
  for (const cmd of ["claude --resume 'abc'", 'claude --resume', "claude --add-dir '/x' --resume 'abc'"]) assert.match(cmd, RESUME_CMD);
  for (const cmd of ["claude --name w 'task'", 'claude', "claude --name w '--resume-ish words'", undefined]) {
    assert.doesNotMatch(cmd || '', RESUME_CMD);
  }
});

/* ── the restore sequence, executed ────────────────────────────────────────── */
test('restored tabs start one at a time; a failure or a session that never comes up does not stop the rest', async () => {
  const clock = { now: 0 };
  const log: string[] = [];
  const panes = new Map<string, Record<string, unknown>>([
    ['r1', { kind: 'restore', name: 'one', sessionId: 's1' }],
    ['r2', { kind: 'restore', name: 'two', sessionId: 's2' }],
    ['r3', { kind: 'restore', name: 'three', sessionId: 's3' }],
  ]);
  let polls2 = 0;
  const materializeRestore = async (id: string) => {
    const ph = panes.get(id)!;
    log.push(`start ${ph.name}@${clock.now}`);
    if (ph.name === 'one') return false;                       // refused before it started
    panes.delete(id);
    panes.set('t-' + id, { kind: 'term', name: ph.name, sessionId: ph.sessionId, exited: false });
    return true;
  };
  const sessionIsLive = async (sid: string) => {
    if (sid === 's2') return ++polls2 >= 3;                     // comes up on the third look
    return false;                                               // s3 never does
  };
  const toasts: string[] = [];
  const src = [
    grab(/const UNATTENDED_WINDOW_MS = [\s\S]*?\nconst RESUME_QUOTA_DIALOG = [^\n]*\n/, 'the unattended constants'),
    grab(/const sleepMs = [^\n]*\n/, 'sleepMs'),
    grab(/async function materializeInSequence\(ids\) \{[\s\S]*?\n\}/, 'materializeInSequence'),
    'return materializeInSequence;',
  ].join('\n');
  const run = new Function('panes', 'materializeRestore', 'window', 'toast', 't', 'console', 'setTimeout', 'Date', src)(
    panes, materializeRestore, { glassShell: { sessionIsLive } },
    (m: string) => toasts.push(m), (k: string, v: { name: string }) => `${k}:${v.name}`,
    { error: (...a: unknown[]) => log.push('error ' + a.slice(0, 2).join(' ')) },
    (fn: () => void, ms: number) => { clock.now += ms; queueMicrotask(fn); return 0; },
    { now: () => clock.now }) as (ids: string[]) => Promise<void>;
  await run(['r1', 'r2', 'r3']);
  const starts = log.filter((l) => l.startsWith('start'));
  assert.deepEqual(starts.map((l) => l.split('@')[0]), ['start one', 'start two', 'start three'], 'every tab is tried, in order');
  const at = (n: string) => Number(starts.find((l) => l.startsWith('start ' + n))!.split('@')[1]);
  assert.ok(at('three') >= at('two') + 2 * 2000 + 4000, 'three waits until two is live (two polls) plus the gap');
  assert.ok(log.some((l) => l.startsWith('error') && l.includes('one')), 'the refusal is logged');
  assert.deepEqual(toasts, ['unattended.notLive:three'], 'the one that never came up is said, once');
  assert.ok(clock.now - at('three') >= 90_000, 'and it was waited for up to the cap, not forever');
  assert.ok(clock.now - at('three') < 90_000 + 2000 + 4000 + 1, 'and not longer');
});

/* ── wiring: source invariants ─────────────────────────────────────────────── */
test('off keeps the offer exactly as it was; on skips the modal and starts the sequence', () => {
  const offer = grab(/async function offerRestore\(\) \{[\s\S]*?\n\}/, 'offerRestore');
  const branch = offer.indexOf("if (UNATTENDED !== 'off') {");
  const modal = offer.indexOf('await checkModal(');
  assert.ok(branch > 0 && modal > branch, 'the unattended branch returns before the modal is ever built');
  const body = offer.slice(branch, modal);
  assert.match(body, /void materializeInSequence\(ids\)/, 'not awaited — launch goes on');
  assert.match(body, /\n    return;\n  \}/, 'and it returns: the modal is never shown in unattended mode');
  assert.match(offer.slice(modal), /void materializeRestore\(ids\[at >= 0 \? at : 0\]\);/, 'the lazy default is untouched');
});

test('the mode is machine-local: localStorage, never the synced settings file', () => {
  assert.match(app, /localStorage\.getItem\(UNATTENDED_KEY\)/);
  assert.match(app, /localStorage\.setItem\(UNATTENDED_KEY, UNATTENDED\)/);
  assert.doesNotMatch(app, /setSetting\('unattended/, 'a synced setting would switch it on for every machine sharing the vault');
  assert.equal(core.unattendedModeOf(null), 'off', 'and nothing stored means off');
});

test('every resumed claude tab is scanned while unanswered, and only when the mode is on', () => {
  assert.match(app, /if \(UNATTENDED !== 'off' && p\.isSession && !p\.uaDone && RESUME_CMD\.test\(p\.cmd \|\| ''\)\) unattendedScan\(m\.id, p, m\.data\);/);
  assert.match(grab(/async function createPane\([\s\S]*?\n\}/, 'createPane'), /bornAt: Date\.now\(\)/,
    'the two-minute window is counted from the tab, so a bus resume is covered like a restore');
});

test('Settings offers the three values, labelled in every locale', () => {
  assert.match(app, /\[\[t\('unattended\.off'\), 'off'\], \[t\('unattended\.summary'\), 'summary'\], \[t\('unattended\.full'\), 'full'\]\]/);
  for (const loc of fs.readdirSync('src/i18n/locales').filter((f) => f.endsWith('.json'))) {
    const L = JSON.parse(fs.readFileSync(`src/i18n/locales/${loc}`, 'utf8')) as Record<string, string>;
    for (const k of ['settings.unattended', 'settings.unattendedHint', 'unattended.off', 'unattended.summary', 'unattended.full', 'unattended.restoring', 'unattended.notLive']) {
      assert.ok(L[k], `${loc} carries ${k}`);
    }
  }
});
