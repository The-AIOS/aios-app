import { BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as aios from './aios';
import { parseRequest, buildSpawnCmd, needsTaskFile, type BusRequest } from '../core/commandBus';
import { buildInboxReadme, shouldWrite } from '../core/inboxReadme';
import {
  INBOX_CONTRACT, MY_SURFACE, HOLD_SUFFIX, holdPathFor, undeliveredPathFor,
  isHoldPath, decideSend, safeNeedle, claimVerdict, canAdoptHold, parseClaim,
  shouldReleaseForSibling, countUserTurnsContaining, verifyVerdict, type SendTarget,
} from '../core/sendQueue';

/**
 * Spawn-inbox command bus (main side) — CONTRACT 2.
 *
 * Watches `~/.aios/spawn-inbox/`; an agent drops a `*.json` request and a trusted surface
 * fulfils it natively. TWO fulfillers exist (this App and the Glass extension) and they
 * race, so the request FILE is the queue rather than a message we consume:
 *
 *   *.json              waiting for a fulfiller
 *   *.json.holding      CLAIMED by one surface (atomic rename), stamped with _claim
 *   *.json.undelivered  gave up, with a reason — a visible artifact, never silence
 *   absent              delivered and VERIFIED
 *
 * Two rules that must never soften, both learned from real losses:
 *  1. Never deliver into a BUSY session. Text sent mid-turn is dropped, not queued. When
 *     the hold budget expires we mark undelivered rather than "trying anyway" — that
 *     timeout path was Glass's 0.4.6 bug and performed the exact loss the gate prevents.
 *  2. "The file is gone" only proves pickup. Delivery is proven in the target's own
 *     transcript, by COUNTING — double delivery is the worst outcome this protocol can
 *     produce, so exactly 1 is the pass condition.
 *
 * Pure decisions live in ../core/sendQueue.ts, ported from Glass's module of the same name
 * so both surfaces provably agree; if they ever diverge, a diff should say so.
 */

const log = (msg: string): void => console.log(`[command-bus] ${msg}`);

/*
 * These timings are CONTRACT, not tuning — they must match the Glass extension's, because
 * both surfaces reason about the same files. The dangerous one is HOLD_STALE_MS: ours was
 * 15 min against Glass's 45, which opens a 30-minute window where Glass still believes it
 * owns a hold while we consider it stale and adopt it. Both then deliver — the exact
 * double-delivery contract 2 exists to prevent. Aligned to Glass's values; longer is the
 * safe direction for adoption, and waiting is cheap when the file is the queue.
 */
/** Addressed elsewhere and unclaimed for this long → any surface may retire it. */
const RETIRE_TTL_MS = 10 * 60_000;        // Glass: TARGET_TTL_MS
/** A hold this old is adoptable even if its claimer still lives. */
const HOLD_STALE_MS = 45 * 60_000;        // Glass: HOLD_STALE_MS
/** How long we wait for a target to go idle before giving up loudly. */
const MAX_HOLD_MS = 30 * 60_000;          // Glass: MAX_HOLD_MS
/** Re-check a held request on this cadence (registry reads are cheap). */
const HOLD_TICK_MS = 3_000;
/** How long to wait for the text to appear in the target's transcript. */
const VERIFY_WINDOW_MS = 20_000;
const VERIFY_TICK_MS = 1_000;
/** Bound on sibling handoffs, so two fulfillers cannot ping-pong a request. */
const MAX_RELEASES = 2;
/**
 * fs.watch fires on CREATE, which can beat the writer's content to disk — so a request can
 * read back empty or half-written. Retiring that as "unparseable" turns a transient read
 * into a permanent failure. Give a fresh file this long to become whole, and re-check once.
 */
const PARSE_GRACE_MS = 2_000;

function inboxDir(): string {
  return path.join(os.homedir(), '.aios', 'spawn-inbox');
}

/**
 * Document the bus in the directory it serves. `~/.aios/spawn-inbox/` is machine-local
 * runtime state, so no repo path can ship this doc — the handler has to write it, which is
 * also why it cannot drift from the handler. Defers to a Glass doc at the same contract,
 * and never downgrades one declaring a higher contract.
 * A README is never a request (only `*.json` is), so this cannot feed the watcher.
 */
function ensureReadme(dir: string, appVersion: string): void {
  const file = path.join(dir, 'README.md');
  try {
    const ours = buildInboxReadme(appVersion);
    let existing: string | undefined;
    try { existing = fs.readFileSync(file, 'utf8'); } catch { /* absent — the case that matters */ }
    if (!shouldWrite(existing, ours)) return;
    fs.writeFileSync(file, ours);
    log(`wrote ${file}`);
  } catch (e) {
    log(`README not written (${e instanceof Error ? e.message : String(e)})`); // non-fatal
  }
}

function emit(win: BrowserWindow | undefined, kind: string, payload: Record<string, unknown>): void {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send('shell:intent', { ...payload, kind })   // kind LAST: the routing key can never be shadowed by a payload field;
  }
}

/** Live session by sanitized name, from the authoritative registry. */
function targetByName(name: string): SendTarget | undefined {
  const hit = aios.listRunningAgents().find((a) => a.name === name);
  if (!hit || !Number.isInteger(hit.pid) || hit.pid <= 1) return undefined;
  return {
    name: hit.name, pid: hit.pid,
    status: String(hit.status || ''), sessionId: String(hit.sessionId || ''),
  };
}

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/** Read the target's transcript; the counting RULE is pure and lives in core/sendQueue. */
function readTranscript(sessionId: string): string {
  if (!sessionId) return '';
  const base = path.join(os.homedir(), '.claude', 'projects');
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(base); } catch { return ''; }
  for (const d of dirs) {
    try { return fs.readFileSync(path.join(base, d, `${sessionId}.jsonl`), 'utf8'); } catch { continue; }
  }
  return '';
}

/** Move a request to `.undelivered`, recording why. Loud beats silent. */
function markUndelivered(fromPath: string, req: BusRequest | null, reason: string): void {
  const dest = undeliveredPathFor(fromPath);
  try {
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(fs.readFileSync(fromPath, 'utf8')); } catch { /* keep what we know */ }
    body._undelivered = { reason, at: Date.now(), surface: MY_SURFACE };
    fs.writeFileSync(dest, JSON.stringify(body, null, 2) + '\n');
    fs.unlinkSync(fromPath);
  } catch {
    try { fs.renameSync(fromPath, dest); } catch { /* already gone */ }
  }
  log(`UNDELIVERED ${path.basename(dest)} — ${reason}${req ? ` (${req.action} '${req.name}')` : ''}`);
}

/** Hand a claim back for a sibling surface/window to try, bounded by `releases`. */
function releaseForSibling(heldPath: string, req: BusRequest, reason: string): boolean {
  if (!shouldReleaseForSibling(req.releases ?? 0, MAX_RELEASES)) return false;
  const releases = (req.releases ?? 0) + 1;
  const back = heldPath.slice(0, -HOLD_SUFFIX.length);
  try {
    const body = JSON.parse(fs.readFileSync(heldPath, 'utf8')) as Record<string, unknown>;
    delete body._claim;                     // an unclaimed file is what a sibling can take
    body.releases = releases;
    fs.writeFileSync(back, JSON.stringify(body, null, 2) + '\n');
    fs.unlinkSync(heldPath);
    log(`released ${path.basename(back)} for a sibling (${reason}); release ${releases}/${MAX_RELEASES}`);
    return true;
  } catch { return false; }
}

/**
 * `send` is the only verb its target's state can refuse, so it gets the full
 * hold → deliver → verify lifecycle. The file on disk IS the queue, so a crash mid-hold
 * leaves a recoverable artifact rather than a lost message.
 */
async function runSend(
  win: () => BrowserWindow | undefined,
  heldPath: string,
  req: BusRequest,
  claimedAt: number,
): Promise<void> {
  if (!req.prompt) { markUndelivered(heldPath, req, "send request carried no 'prompt'"); return; }
  const needle = safeNeedle(req.prompt);
  for (;;) {
    const target = targetByName(req.name);
    const decision = decideSend(target, Date.now() - claimedAt, MAX_HOLD_MS);
    if (decision.do === 'undeliverable') { markUndelivered(heldPath, req, decision.reason); return; }
    if (decision.do === 'hold') {
      if (!fs.existsSync(heldPath)) return;   // adopted or cleaned up elsewhere
      await new Promise((r) => setTimeout(r, HOLD_TICK_MS));
      continue;
    }
    // idle → deliver, then prove it in the target's own transcript
    const sessionId = target ? target.sessionId : '';
    const before = countUserTurnsContaining(readTranscript(sessionId), needle);
    emit(win(), 'sendByName', { name: req.name, text: req.prompt });
    const until = Date.now() + VERIFY_WINDOW_MS;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, VERIFY_TICK_MS));
      const now = countUserTurnsContaining(readTranscript(sessionId), needle);
      const verdict = verifyVerdict(before, now);
      if (verdict === 'pending') continue;
      try { fs.unlinkSync(heldPath); } catch { /* already gone */ }
      if (verdict === 'duplicate') {
        log(`DUPLICATE DELIVERY → '${req.name}': ${now - before} user turns from one send — INVESTIGATE`);
      } else {
        log(`delivered → '${req.name}' (verified)`);
      }
      return;
    }
    // It never landed. A sibling window or the other surface may own that terminal, and
    // handing the claim back is very different from declaring the message undeliverable.
    if (releaseForSibling(heldPath, req, 'not verified in the target transcript')) return;
    markUndelivered(heldPath, req,
      `sent to '${req.name}' but it never appeared in that session's transcript, and the sibling-release budget is spent`);
    return;
  }
}

/** spawn / kill act immediately once claimed — nothing about the target can refuse them. */
function runImmediate(win: () => BrowserWindow | undefined, heldPath: string, req: BusRequest): void {
  try {
    if (req.action === 'kill') {
      // Registry pid → SIGTERM reaches resumed/external sessions too; closeByName also
      // tears down the app pane if this session owns one.
      const t = targetByName(req.name);
      if (t) { try { process.kill(t.pid, 'SIGTERM'); } catch { /* already gone */ } }
      emit(win(), 'closeByName', { name: req.name });
      log(`kill '${req.name}'${t ? ` (pid ${t.pid})` : ' (no live pid; pane close only)'}`);
    } else if (targetByName(req.name)) {
      emit(win(), 'focusByName', { name: req.name });   // reveal, never duplicate
      log(`'${req.name}' already running — revealed`);
    } else {
      let taskFile: string | undefined;
      if (needsTaskFile(req.task)) {
        taskFile = path.join(os.tmpdir(), `aios-spawn-task-${req.name}.md`);
        try { fs.writeFileSync(taskFile, req.task as string); } catch { taskFile = undefined; }
      }
      // No task → a bootstrap prompt, so the worker runs its Session Start Ritual on turn
      // one instead of sitting idle (mirrors the `spawn` wrapper).
      const cmd = buildSpawnCmd(aios.shellSettings().claudeCmd, req.name, {
        task: req.task || 'Start session', model: req.model, tier: req.tier, taskFile,
      });
      emit(win(), 'terminal', { name: req.name, cmd });
      log(`spawn '${req.name}'${req.task ? ' with task' : ''}${req.model ? ` [model ${req.model}]` : req.tier ? ` [tier ${req.tier}]` : ''}${taskFile ? ' (task via file)' : ''}`);
    }
    try { fs.unlinkSync(heldPath); } catch { /* already gone */ }
  } catch (e) {
    markUndelivered(heldPath, req, `${req.action} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Claim a `*.json` request: decide whether it is ours at all, then take it by ATOMIC
 * RENAME out of the watch glob, stamping who holds it. Returns undefined when we
 * deliberately left it alone.
 */
function claim(fsPath: string): { heldPath: string; req: BusRequest; at: number } | undefined {
  let raw: string;
  try { raw = fs.readFileSync(fsPath, 'utf8'); } catch { return undefined; } // gone / mid-write
  let ageMs = 0;
  try { ageMs = Date.now() - fs.statSync(fsPath).mtimeMs; } catch { /* treat as fresh */ }
  const req = parseRequest(raw);
  if (!req) {
    // A file younger than the grace window is probably still being written (fs.watch fires
    // on create). Leave it and look once more; only a file that is BOTH old enough and
    // still unparseable is genuinely malformed.
    if (ageMs < PARSE_GRACE_MS) { setTimeout(() => recheck(fsPath), PARSE_GRACE_MS); return undefined; }
    markUndelivered(fsPath, null, 'unparseable request (bad JSON, or no usable name)');
    return undefined;
  }
  const verdict = claimVerdict(req.surface, MY_SURFACE, ageMs, RETIRE_TTL_MS);
  if (verdict === 'skip') return undefined;   // addressed elsewhere: do not touch it at all
  if (verdict === 'retire') {
    markUndelivered(fsPath, req, `addressed to '${req.surface}' but unclaimed for ${Math.round(ageMs / 60000)} min`);
    return undefined;
  }
  const heldPath = holdPathFor(fsPath);
  const at = Date.now();
  try {
    const body = JSON.parse(raw) as Record<string, unknown>;
    body._claim = { surface: MY_SURFACE, pid: process.pid, at };
    fs.writeFileSync(fsPath, JSON.stringify(body, null, 2) + '\n');
    fs.renameSync(fsPath, heldPath);   // atomic: exactly one surface can win
  } catch { return undefined; }        // lost the race, or it vanished — either is fine
  return { heldPath, req, at };
}

/** Set by initCommandBus so the parse-grace re-check can reach the same pipeline. */
let recheck: (fsPath: string) => void = () => { /* until the bus starts */ };

function consume(win: () => BrowserWindow | undefined, fsPath: string): void {
  const held = claim(fsPath);
  if (!held) return;
  if (held.req.action === 'send') void runSend(win, held.heldPath, held.req, held.at);
  else runImmediate(win, held.heldPath, held.req);
}

/** Recover `.holding` files left by a crash — but never steal a live sibling's hold. */
function adoptHolds(win: () => BrowserWindow | undefined, dir: string): void {
  let files: string[] = [];
  try { files = fs.readdirSync(dir); } catch { return; }
  for (const f of files) {
    if (!isHoldPath(f)) continue;
    const p = path.join(dir, f);
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
    const stamp = parseClaim(body._claim);
    const holderAlive = !!stamp && stamp.pid !== process.pid && alive(stamp.pid);
    if (!canAdoptHold(stamp, Date.now(), HOLD_STALE_MS, holderAlive)) {
      log(`leaving ${f} — held by a live ${stamp?.surface} (pid ${stamp?.pid})`);
      continue;
    }
    const req = parseRequest(JSON.stringify(body));
    if (!req) { markUndelivered(p, null, 'unparseable held request'); continue; }
    log(`adopting ${f} (${stamp ? `holder pid ${stamp.pid} gone or hold stale` : 'unstamped, contract-1 era'})`);
    body._claim = { surface: MY_SURFACE, pid: process.pid, at: Date.now() };
    try { fs.writeFileSync(p, JSON.stringify(body, null, 2) + '\n'); } catch { /* keep going */ }
    if (req.action === 'send') void runSend(win, p, req, Date.now());
    else runImmediate(win, p, req);
  }
}

export function initCommandBus(getWin: () => BrowserWindow | undefined, appVersion = '0.0.0'): void {
  const dir = inboxDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* non-fatal */ }
  ensureReadme(dir, appVersion);
  recheck = (p: string) => { if (fs.existsSync(p)) consume(getWin, p); };
  try {
    // Only `*.json` is a request — `.holding` and `.undelivered` sit deliberately OUTSIDE
    // the glob, so a claimed or abandoned request can never be re-picked-up as a new one.
    fs.watch(dir, (_evt, filename) => {
      const f = String(filename || '');
      if (!f.endsWith('.json')) return;
      const p = path.join(dir, f);
      if (fs.existsSync(p)) consume(getWin, p);
    });
  } catch (e) {
    log(`watch failed on ${dir} (${e instanceof Error ? e.message : String(e)})`);
  }
  // Requests dropped while the app was closed, then holds left behind by a crash.
  try {
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.json')) consume(getWin, path.join(dir, f));
    }
  } catch { /* empty/absent inbox */ }
  adoptHolds(getWin, dir);
  log(`watching ${dir} (contract ${INBOX_CONTRACT}, surface '${MY_SURFACE}')`);
}
