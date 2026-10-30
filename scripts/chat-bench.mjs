#!/usr/bin/env node
/**
 * chat-bench — what the chat view costs on a long transcript, measured on synthetic ones.
 *
 * Usage:   npm run chat:bench                                  → 5000 and 50000 lines, both halves, markdown table
 *          npm run chat:bench -- --lines 5000                  → one size (comma list: 5000,50000)
 *          npm run chat:bench -- --mix chatty                  → conversation-dense mix instead of the realistic one
 *          npm run chat:bench -- --only main | --only renderer → just one half
 *          npm run chat:bench -- --seed 7 --live 60            → another PRNG seed / number of live-appended lines
 *
 * TWO HALVES, because the cost lives in two processes:
 *  - MAIN (plain node, no Electron): out/main/transcriptTail.js follows the synthetic file exactly as the App does.
 *    Reports reset→last-items→turn (the end of the backfill), how many events and bytes (JSON size of every event, the
 *    stand-in for what crosses IPC) it produced, and the time from appending one line to its `items` event.
 *  - RENDERER: the real renderer in the hidden window of `--chat-shot` (+ `--chat-bench`, see main.ts), driven by a
 *    one-shot fixture. The pane is pointed at the synthetic transcript and the REAL path runs: tail → IPC →
 *    chatSkinHandleEvent → DOM. DOM nodes are counted inside cs.log and in the whole document; the heap comes from
 *    performance.memory after a forced GC; the process numbers (working set, private bytes, main RSS) come from main.
 *
 * WHAT A NUMBER MEANS (and does not):
 *  - "load" is measured from the moment the pane is pointed at the file to the `turn` event that ends the backfill
 *    (+ the last row's handler having returned). It is JS + IPC time. "layout" is a forced synchronous layout right after,
 *    so style+layout cost is counted even if no frame is ever produced. "first frame" is two requestAnimationFrame
 *    callbacks; the hidden window runs with backgroundThrottling:false (see createWindow), and the script PRINTS the rAF
 *    rate it measured and refuses to call anything "frame" time when it is 0. Paint/composite of a window that is never
 *    on screen is NOT measured: a hidden window may skip them, so "first frame" is a lower bound on what an operator sees.
 *  - "per new line" is the renderer's handler (first row built → handler returned) plus a forced layout, for lines that
 *    arrive live through the real tail. Lines that make no row are not in it.
 *  - Heap is performance.memory.usedJSHeapSize after gc(); working set / private bytes are the OS view of the renderer
 *    process (they include Chromium's own baseline, so read DIFFERENCES between sizes, not the absolute value).
 *
 * ISOLATION (same as chat-shot.mjs): synthetic HOME, throwaway userData, command bus off, hidden window only — nothing here
 * can show a window, touch /Applications/AIOS.app, or read the operator's data. The transcripts are written to a temp
 * folder with the prefix below; this script deletes only folders it created there.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PREFIX = 'aios-chatbench-';
const SID = '00000000-0000-4000-8000-0000000b3c4e';

// ── synthetic transcripts ────────────────────────────────────────────────────────────────────────
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Line mix. `real` is calibrated on the proportions and sizes of a real 35 MB / 1.6k-line transcript (counts by line type
 *  only, no content): most lines are bookkeeping, a tool result averages ~160 KB, only ~4% of lines are conversation text. */
const MIXES = {
  real:   { w: { attachment: 212, blob: 165, req: 83, thinking: 41, small: 240, sys: 20, text: 25, user: 16, queue: 15, snap: 11, shape: 2, tool: 86 }, res: { mu: Math.log(32000), sigma: 1.8, max: 2_000_000 } },
  chatty: { w: { attachment: 5, small: 30, thinking: 60, sys: 40, text: 280, user: 120, tool: 200 }, res: { mu: Math.log(1500), sigma: 1.0, max: 40_000 } },
};
const WORDS = 'the a of to and in is it for with on as this that we are be from by an or not use file line test view chat row load tail page code run build step check when then list item state paint node tool path scroll render turn read write open close merge reset'.split(' ');

function makeGen(seed, mixName) {
  const mix = MIXES[mixName];
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const int = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const hex = (n) => { let s = ''; while (s.length < n) s += Math.floor(r() * 16).toString(16); return s; };
  const uuid = () => `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`;
  const sentence = () => { const n = int(5, 14); const w = []; for (let i = 0; i < n; i++) w.push(pick(WORDS)); const s = w.join(' '); return s[0].toUpperCase() + s.slice(1) + '.'; };
  const para = () => { const n = int(1, 4); const s = []; for (let i = 0; i < n; i++) s.push(sentence()); return s.join(' '); };
  const codeBlock = () => { const n = int(4, 22); const l = []; for (let i = 0; i < n; i++) l.push(`${'  '.repeat(int(0, 3))}const ${pick(WORDS)}${int(1, 99)} = ${pick(WORDS)}(${int(0, 9)}, '${pick(WORDS)}');`); return '```ts\n' + l.join('\n') + '\n```'; };
  const markdown = () => {
    const parts = [para()];
    if (r() < 0.5) parts.push('- ' + sentence() + '\n- ' + sentence() + '\n- `' + pick(WORDS) + '()` ' + sentence());
    if (r() < 0.45) parts.push(codeBlock());
    if (r() < 0.3) parts.push('See **' + pick(WORDS) + '** in `src/main/' + pick(WORDS) + '.ts` and [the docs](https://example.com/' + pick(WORDS) + ').');
    if (r() < 0.5) parts.push(para());
    return parts.join('\n\n');
  };
  // one big pool, sliced for results and blobs: generating 160 KB of fresh random text per line would dominate the run
  let pool = ''; while (pool.length < 262144) pool += sentence() + (r() < 0.25 ? '\n' : ' ') + (r() < 0.1 ? `/Users/someone/project/src/${pick(WORDS)}.ts:${int(1, 900)}\n` : '');
  const slice = (n) => { let out = ''; while (out.length < n) { const a = int(0, pool.length - 1); out += pool.slice(a, Math.min(pool.length, a + (n - out.length))); } return out; };
  const gauss = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
  const resultSize = () => Math.min(mix.res.max, Math.max(40, Math.round(Math.exp(mix.res.mu + mix.res.sigma * gauss()))));

  let i = 0, parent = null;
  const ts = () => new Date(Date.UTC(2026, 0, 1, 10, 0, 0) + (i++) * 1500).toISOString();
  const J = (o) => JSON.stringify(o);
  const base = (type) => { const u = uuid(); const o = { parentUuid: parent, isSidechain: false, type, uuid: u, timestamp: ts(), sessionId: SID }; parent = u; return o; };
  const usage = () => ({ input_tokens: int(3, 40), cache_creation_input_tokens: int(100, 3000), cache_read_input_tokens: int(5000, 90000), output_tokens: int(20, 900) });
  const asst = (block, stop, msgId) => J({ ...base('assistant'), message: { id: msgId ?? 'msg_' + hex(20), role: 'assistant', model: 'model-x', stop_reason: stop, content: [block], usage: usage() } });
  const user = (content) => J({ ...base('user'), message: { role: 'user', content } });
  const toolInput = (name) => name === 'Bash' ? { command: `${pick(WORDS)} ${pick(WORDS)} --${pick(WORDS)} ${int(1, 99)}` }
    : name === 'Grep' ? { pattern: pick(WORDS), path: 'src' } : name === 'Edit' ? { file_path: `src/${pick(WORDS)}.ts`, old_string: sentence(), new_string: sentence() } : { file_path: `src/${pick(WORDS)}/${pick(WORDS)}.ts` };
  const pending = [];   // tool results waiting to be written a few lines after their call
  const small = () => {
    const k = pick(['custom-title', 'agent-name', 'last-prompt', 'mode', 'permission-mode', 'bridge-session', 'atis-latch']);
    return J({ type: k, sessionId: SID, value: hex(int(20, 120)) });
  };
  const KINDS = {
    attachment: () => J({ type: 'attachment', attachment: { type: 'hook_success', content: slice(int(1800, 3400)) }, uuid: uuid(), timestamp: ts() }),
    blob: () => J({ type: 'api-request-blob', data: slice(int(20000, 55000)) }),
    req: () => J({ type: 'api-request', model: 'model-x', note: slice(int(1200, 2200)) }),
    thinking: () => asst({ type: 'thinking', thinking: slice(int(1500, 4500)) }, 'tool_use'),
    small,
    sys: () => J({ ...base('system'), subtype: 'turn_duration', durationMs: int(500, 90000) }),
    text: () => asst({ type: 'text', text: markdown() }, pick(['end_turn', 'tool_use'])),
    user: () => user(markdown().slice(0, int(40, 600))),
    queue: () => J({ type: 'queue-operation', operation: 'enqueue', content: slice(int(800, 2000)) }),
    snap: () => J({ type: 'file-history-snapshot', messageId: uuid(), snapshot: { trackedFileBackups: {} } }),
    shape: () => J({ type: 'api-request-shape', shape: slice(int(70000, 120000)) }),
    tool: () => {
      const name = pick(['Read', 'Read', 'Bash', 'Bash', 'Grep', 'Edit']);
      const id = 'toolu_' + hex(22);
      pending.push({ at: i + int(0, 3), id, size: resultSize(), err: r() < 0.06 });
      return asst({ type: 'tool_use', id, name, input: toolInput(name) }, 'tool_use');
    },
  };
  const total = Object.values(mix.w).reduce((a, b) => a + b, 0);
  const roll = () => { let x = r() * total; for (const [k, w] of Object.entries(mix.w)) { x -= w; if (x < 0) return k; } return 'small'; };
  const result = (p) => user([{ type: 'tool_result', tool_use_id: p.id, content: slice(p.size), ...(p.err ? { is_error: true } : {}) }]);
  return {
    next() {
      const due = pending.findIndex((p) => p.at <= i);
      if (due !== -1) return result(pending.splice(due, 1)[0]);
      return KINDS[roll()]();
    },
    /** Lines that each make a row or update one — what a live session appends. */
    live(n) {
      const out = [];
      for (let k = 0; out.length < n; k++) {
        const step = k % 5;
        if (step === 0) out.push(KINDS.user());
        else if (step === 1 || step === 4) out.push(KINDS.text());
        else { const p = { id: 'toolu_' + hex(22), size: int(3000, 30000), err: false }; out.push(asst({ type: 'tool_use', id: p.id, name: 'Bash', input: toolInput('Bash') }, 'tool_use')); if (out.length < n) out.push(result(p)); }
      }
      return out.slice(0, n);
    },
  };
}

async function writeTranscript(file, lines, seed, mixName) {
  const g = makeGen(seed, mixName);
  const fd = fs.openSync(file, 'w');
  let buf = [], size = 0, bytes = 0;
  const flush = () => { if (buf.length) { fs.writeSync(fd, buf.join('')); buf = []; size = 0; } };
  for (let n = 0; n < lines; n++) { const l = g.next() + '\n'; buf.push(l); size += l.length; bytes += l.length; if (size > 8_000_000) flush(); }
  flush(); fs.closeSync(fd);
  return fs.statSync(file).size;
}

// ── helpers ────────────────────────────────────────────────────────────────────────────────────────
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const p95 = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]; };
const r1 = (x) => (x === null || x === undefined ? null : Math.round(x * 10) / 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── MAIN half: runs in a child node process (own heap, --expose-gc) ──────────────────────────────────
async function mainWorker(projects, file, liveFile) {
  const { createTranscriptTail } = await import(pathToFileURL(path.join(ROOT, 'out', 'main', 'transcriptTail.js')).href);
  const tail = createTranscriptTail({ projectsDir: () => projects });
  const t0 = performance.now();
  const cpu0 = process.cpuUsage();
  const tl = { reset: null, firstItems: null, lastItems: null, turn: null };
  const counts = { events: 0, itemsEvents: 0, items: 0, bytes: 0 };
  let onItems = null;
  let ended = false;
  const done = new Promise((res) => {
    tail.watch(1, SID, (ev) => {
      const t = performance.now() - t0;
      counts.events++;
      counts.bytes += JSON.stringify(ev).length;   // what structured-clone would have to carry across IPC (stand-in)
      if (ev.type === 'reset' && tl.reset === null) tl.reset = t;
      if (ev.type === 'items') { counts.itemsEvents++; counts.items += ev.items.length; if (tl.firstItems === null) tl.firstItems = t; tl.lastItems = t; if (onItems) onItems(performance.now()); }
      if (ev.type === 'turn' && !ended) { ended = true; tl.turn = t; res(); }
    });
  });
  await Promise.race([done, sleep(240000).then(() => { throw new Error('backfill did not end in 240 s'); })]);
  const loadCounts = { ...counts };
  const cpu = process.cpuUsage(cpu0);
  const loadCpuMs = (cpu.user + cpu.system) / 1000;
  await sleep(300);
  global.gc?.(); global.gc?.();
  const mu = process.memoryUsage();
  const afterLoad = { rssMB: mu.rss / 1048576, heapMB: mu.heapUsed / 1048576, maxRssMB: process.resourceUsage().maxRSS / 1024 };
  // live lines: one at a time, each awaited, so the latency is for THIS line
  const live = fs.readFileSync(liveFile, 'utf8').split('\n').filter(Boolean);
  const lat = [];
  for (const line of live) {
    const w = performance.now();
    const got = new Promise((res) => { onItems = res; });
    fs.appendFileSync(file, line + '\n');
    const t = await Promise.race([got, sleep(3000).then(() => null)]);
    onItems = null;
    if (t !== null) lat.push(t - w);
    await sleep(40);
  }
  tail.unwatchAll();
  console.log('BENCH-MAIN ' + JSON.stringify({ ...tl, ...counts, load: loadCounts, loadCpuMs, afterLoad, liveLines: live.length, liveGot: lat.length, liveMedianMs: median(lat), liveP95Ms: p95(lat) }));
}

// ── RENDERER half: the fixture's script (runs in the page; ctx is chat-shot's) ───────────────────────
const DRIVER = String.raw`
const { id, p, cs, sleep } = ctx;
const SID = '__SID__', K = __K__;
const out = (kind, o) => console.log('chat-bench:data ' + kind + ' ' + JSON.stringify(o));
const nodesIn = (n) => n.getElementsByTagName('*').length;
const heapMB = async () => { if (window.gc) { window.gc(); await sleep(80); window.gc(); } const m = performance.memory; return m ? +(m.usedJSHeapSize / 1048576).toFixed(1) : null; };
const probe = async (label) => { const h = await heapMB(); out('heap', { label, heapMB: h }); console.log('chat-bench:probe ' + label); await sleep(900); };
const until = async (fn, what, ms) => { const t = performance.now(); while (!fn()) { if (performance.now() - t > ms) throw new Error('timed out: ' + what); await sleep(20); } };
const frames = (ms) => new Promise((res) => { let n = 0; const t = performance.now(); const f = () => { n++; if (performance.now() - t < ms) requestAnimationFrame(f); else res(n / ((performance.now() - t) / 1000)); }; requestAnimationFrame(f); setTimeout(() => res(0), ms + 2000); });
out('env', { hidden: document.hidden, visibility: document.visibilityState, hasFocus: document.hasFocus(), rafPerSecond: +(await frames(600)).toFixed(1), preciseMemory: !!(performance.memory && window.gc) });
const idle = { logNodes: nodesIn(cs.log), docNodes: document.getElementsByTagName('*').length };
await probe('idle');

const evs = [];
let upsertAt = null, withLayout = false;
const longTasks = [];
try { new PerformanceObserver((l) => { for (const e of l.getEntries()) longTasks.push({ s: e.startTime, d: e.duration }); }).observe({ entryTypes: ['longtask'] }); } catch (e) { /* not available */ }
const upsert0 = window.chatSkinUpsert;
window.chatSkinUpsert = function () { if (upsertAt === null) upsertAt = performance.now(); return upsert0.apply(this, arguments); };
window.glassShell.onChatSkinEvent((ev) => {
  if (ev.paneId !== id) return;
  const t = performance.now();
  const rec = { t, type: ev.type, sid: ev.sid, n: ev.items ? ev.items.length : 0, handlerMs: upsertAt === null ? 0 : t - upsertAt };
  upsertAt = null;
  if (withLayout) { const l = performance.now(); cs.log.getBoundingClientRect(); rec.layoutMs = performance.now() - l; }
  evs.push(rec);
});

// ── load ──
const t0 = performance.now();
p.sessionId = SID;
chatSkinSync(id, p);
await until(() => evs.some((e) => e.type === 'turn'), 'the end of the backfill', 270000);
const turnEv = evs.find((e) => e.type === 'turn');
const itemsEvs = evs.filter((e) => e.type === 'items');
const l0 = performance.now(); cs.log.getBoundingClientRect(); document.body.getBoundingClientRect(); const layoutMs = performance.now() - l0;
const f0 = performance.now();
const framed = await new Promise((res) => { requestAnimationFrame(() => requestAnimationFrame(() => res(true))); setTimeout(() => res(false), 3000); });
const frameMs = performance.now() - f0;
const load = {
  resetMs: (evs.find((e) => e.type === 'reset') || { t: NaN }).t - t0,
  firstItemsMs: itemsEvs.length ? itemsEvs[0].t - t0 : null,
  lastItemsMs: itemsEvs.length ? itemsEvs[itemsEvs.length - 1].t - t0 : null,
  endMs: turnEv.t - t0, layoutMs, firstFrameAfterMs: framed ? frameMs : null,
  itemsEvents: itemsEvs.length, itemsPainted: itemsEvs.reduce((a, e) => a + e.n, 0),
  handlerMsTotal: itemsEvs.reduce((a, e) => a + e.handlerMs, 0), handlerMsMax: Math.max(0, ...itemsEvs.map((e) => e.handlerMs)),
  longTaskMax: Math.max(0, ...longTasks.filter((x) => x.s >= t0).map((x) => x.d)), longTaskSum: longTasks.filter((x) => x.s >= t0).reduce((a, x) => a + x.d, 0),
  rows: cs.items.size, logChildren: cs.log.children.length, logNodes: nodesIn(cs.log), docNodes: document.getElementsByTagName('*').length, scrollHeight: cs.log.scrollHeight,
};
out('load', load);
await probe('loaded');

// ── live lines through the real tail (the runner appends them when it sees the marker) ──
withLayout = true;
const from = evs.length;
console.log('chat-bench: append-ready');
await until(() => evs.slice(from).filter((e) => e.type === 'items').length >= K, 'the live lines', 90000).catch(() => {});
const live = evs.slice(from).filter((e) => e.type === 'items');
const med = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const q95 = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]; };
const hm = live.map((e) => e.handlerMs), lm = live.map((e) => e.layoutMs || 0), both = live.map((e) => e.handlerMs + (e.layoutMs || 0));
out('live', { got: live.length, handlerMedianMs: med(hm), handlerP95Ms: q95(hm), layoutMedianMs: med(lm), layoutP95Ms: q95(lm), totalMedianMs: med(both), totalP95Ms: q95(both), rows: cs.items.size, logNodes: nodesIn(cs.log), docNodes: document.getElementsByTagName('*').length });
withLayout = false;
await probe('after-live');

// ── scrolling back (a build without paging simply has nothing more to bring) ──
await sleep(500);
cs.stick = false;
cs.log.scrollTop = Math.max(0, cs.log.scrollHeight - cs.log.clientHeight - 400);
cs.log.dispatchEvent(new Event('scroll'));
await sleep(300);
// a bubble on screen, not a tool row (those can be folded into a run when older ones arrive): where it sits must not change
cs.log.scrollTop = 500; await sleep(100);
const lb = () => cs.log.getBoundingClientRect();
const bubble = Array.from(cs.log.querySelectorAll('.chat-row')).find((n) => n.getBoundingClientRect().top >= lb().top && n.getBoundingClientRect().bottom <= lb().bottom);
const rowsBefore = cs.items.size;
cs.log.scrollTop = 0;
const at0 = bubble ? bubble.getBoundingClientRect().top - lb().top : null;   // forced layout: before anything could load
cs.log.dispatchEvent(new Event('scroll'));
const s0 = performance.now();
await until(() => cs.items.size > rowsBefore, 'earlier rows', 6000).catch(() => {});
await sleep(500);
const at1 = bubble && bubble.isConnected ? bubble.getBoundingClientRect().top - lb().top : null;
out('scrollback', { rowsBefore, rowsAfter: cs.items.size, loadedInMs: cs.items.size > rowsBefore ? performance.now() - s0 : null, bubbleShiftPx: at0 === null || at1 === null ? null : Math.round(at1 - at0), scrollTop: Math.round(cs.log.scrollTop), logNodes: nodesIn(cs.log), earlierStillAvailable: !!cs.earlier });
await probe('after-scrollback');
console.log('chat-bench: renderer-done');
`;

// ── runner ───────────────────────────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); if (i === -1) return dflt; const v = args[i + 1]; if (!v || v.startsWith('--')) { console.error(`chat-bench: ${name} needs a value`); process.exit(2); } return v; };
for (const a of args) if (a.startsWith('--') && !['--lines', '--mix', '--only', '--seed', '--live', '--tail-worker', '--keep-out'].includes(a)) { console.error(`chat-bench: unknown option ${a}`); process.exit(2); }

if (args[0] === '--tail-worker') { await mainWorker(args[1], args[2], args[3]); process.exit(0); }

const sizes = opt('--lines', '5000,50000').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
const mixName = opt('--mix', 'real');
const only = opt('--only', 'both');
const seed = Number(opt('--seed', '1'));
const K = Number(opt('--live', '60'));
if (!MIXES[mixName] || !sizes.length || !['both', 'main', 'renderer'].includes(only) || !Number.isFinite(seed) || !(K > 0)) { console.error('chat-bench: bad arguments'); process.exit(2); }

const isOurTemp = (dir) => { try { const real = fs.realpathSync(dir); const tmp = fs.realpathSync(os.tmpdir()); return real.startsWith(tmp + path.sep) && path.basename(real).startsWith(PREFIX); } catch { return false; } };
const created = [];
const cleanup = () => { for (const d of created.splice(0)) if (isOurTemp(d)) fs.rmSync(d, { recursive: true, force: true }); };
process.on('exit', cleanup);

function runMain(projects, file, liveFile) {
  return new Promise((res, rej) => {
    const c = spawn(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--tail-worker', projects, file, liveFile], { stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = ''; c.stdout.on('data', (d) => { buf += d; });
    c.on('exit', (code) => { const m = /^BENCH-MAIN (.+)$/m.exec(buf); if (code === 0 && m) res(JSON.parse(m[1])); else rej(new Error('main worker failed (exit ' + code + ')\n' + buf.slice(-400))); });
  });
}

async function runRenderer(work, file, liveLines) {
  const home = path.join(work, 'home');
  const userData = path.join(work, 'userdata');
  fs.mkdirSync(userData, { recursive: true });
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'demo.mjs'), '--build-only', '--out', home], { stdio: 'ignore' });
  const proj = path.join(home, '.claude', 'projects', '-bench');
  fs.mkdirSync(proj, { recursive: true });
  fs.copyFileSync(file, path.join(proj, SID + '.jsonl'));
  const fixture = path.join(work, 'fixture.json');
  fs.writeFileSync(fixture, JSON.stringify({ version: 1, settleMs: 200, layout: 'dock-max', shots: [{ name: 'bench', events: [], working: false, js: DRIVER.replace('__SID__', SID).replace('__K__', String(K)) }] }));
  const shots = path.join(work, 'shots');
  const electron = path.join(ROOT, 'node_modules', '.bin', 'electron');
  const env = { ...process.env, HOME: home, USERPROFILE: home, AIOS_BUS_DISABLED: '1', GLASS_FRAMEWORK_PATH: path.join(home, 'aios') };
  delete env.ELECTRON_RUN_AS_NODE; delete env.CLAUDE_CONFIG_DIR;
  const child = spawn(electron, ['.', `--user-data-dir=${userData}`, '--use-mock-keychain', `--chat-shot=${shots}`, `--chat-shot-fixture=${fixture}`, '--chat-bench'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const got = { data: {}, heap: {}, metrics: {}, errors: [] };
  const target = path.join(proj, SID + '.jsonl');
  let appended = false, tail = '';
  const onLine = async (line) => {
    let m;
    if ((m = /chat-bench:data (\w+) (.+)$/.exec(line))) { const o = JSON.parse(m[2]); if (m[1] === 'heap') got.heap[o.label] = o.heapMB; else got.data[m[1]] = o; }
    else if ((m = /chat-bench: metrics (\S+) (.+)$/.exec(line))) got.metrics[m[1]] = JSON.parse(m[2]);
    else if (/chat-bench: append-ready/.test(line) && !appended) { appended = true; for (const l of liveLines) { fs.appendFileSync(target, l + '\n'); await sleep(250); } }
    else if (/FAILED|Uncaught|timed out/.test(line)) { got.errors.push(line.slice(0, 300)); }
    tail = (tail + '\n' + line).slice(-3000);
  };
  for (const s of [child.stdout, child.stderr]) { let b = ''; s.on('data', (d) => { b += d; let i; while ((i = b.indexOf('\n')) !== -1) { void onLine(b.slice(0, i)); b = b.slice(i + 1); } }); }
  const killer = setTimeout(() => child.kill('SIGKILL'), 420_000);   // only ever the pid this script started
  const code = await new Promise((res) => { child.on('exit', (c) => res(c ?? 1)); child.on('error', () => res(1)); });
  clearTimeout(killer);
  if (code !== 0 || !got.data.load) throw new Error(`renderer half failed (exit ${code}). Errors: ${got.errors.join(' | ')}\n${tail.slice(-800)}`);
  return got;
}

const results = [];
for (const lines of sizes) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `${PREFIX}${lines}-`));
  created.push(work);
  const file = path.join(work, 'projects', '-bench', SID + '.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const t = Date.now();
  const bytes = await writeTranscript(file, lines, seed, mixName);
  const liveLines = makeGen(seed + 1000, mixName).live(K);
  const liveFile = path.join(work, 'live.jsonl');
  fs.writeFileSync(liveFile, liveLines.join('\n') + '\n');
  console.error(`chat-bench: ${lines} lines (${mixName}, seed ${seed}) → ${(bytes / 1048576).toFixed(1)} MB, generated in ${((Date.now() - t) / 1000).toFixed(1)} s`);
  const row = { lines, mb: +(bytes / 1048576).toFixed(1), mix: mixName, seed };
  if (only !== 'renderer') {
    const mainCopy = path.join(work, 'main-projects');
    fs.mkdirSync(path.join(mainCopy, '-bench'), { recursive: true });
    fs.copyFileSync(file, path.join(mainCopy, '-bench', SID + '.jsonl'));
    row.main = await runMain(mainCopy, path.join(mainCopy, '-bench', SID + '.jsonl'), liveFile);
    fs.rmSync(mainCopy, { recursive: true, force: true });
  }
  if (only !== 'main') row.renderer = await runRenderer(work, file, liveLines);
  results.push(row);
  cleanup();
}

// ── report ───────────────────────────────────────────────────────────────────────────────────────────
console.log('\n' + JSON.stringify(results, null, 1));
const f = (x, d = 0) => (x === null || x === undefined || Number.isNaN(x) ? 'n/a' : Number(x).toFixed(d));
const line = (label, fn) => `| ${label} | ${results.map((r) => { try { return fn(r); } catch { return 'n/a'; } }).join(' | ')} |`;
const head = `| | ${results.map((r) => `${r.lines} lines`).join(' | ')} |\n|---|${results.map(() => '---').join('|')}|`;
const rows = [
  line('file size (MB)', (r) => f(r.mb, 1)),
  line('main: backfill reset→turn (ms)', (r) => f(r.main.turn)),
  line('main: events / items / IPC-size (MB)', (r) => `${r.main.load.events} / ${r.main.load.items} / ${f(r.main.load.bytes / 1048576, 2)}`),
  line('main: CPU for the load (ms)', (r) => f(r.main.loadCpuMs)),
  line('main: line appended→items event, median / p95 (ms)', (r) => `${f(r.main.liveMedianMs, 1)} / ${f(r.main.liveP95Ms, 1)}`),
  line('main (node): RSS / heap after load, MB (peak RSS)', (r) => `${f(r.main.afterLoad.rssMB)} / ${f(r.main.afterLoad.heapMB)} (${f(r.main.afterLoad.maxRssMB)})`),
  line('renderer: load, reset→last row (ms)', (r) => f(r.renderer.data.load.lastItemsMs - r.renderer.data.load.resetMs)),
  line('renderer: load, pointing the pane→end of backfill (ms)', (r) => f(r.renderer.data.load.endMs)),
  line('renderer: forced layout after load (ms)', (r) => f(r.renderer.data.load.layoutMs, 1)),
  line('renderer: two rAF after load (ms)', (r) => f(r.renderer.data.load.firstFrameAfterMs, 1)),
  line('renderer: longest long task / sum (ms)', (r) => `${f(r.renderer.data.load.longTaskMax)} / ${f(r.renderer.data.load.longTaskSum)}`),
  line('renderer: per new line, handler median / p95 (ms)', (r) => `${f(r.renderer.data.live.handlerMedianMs, 2)} / ${f(r.renderer.data.live.handlerP95Ms, 2)}`),
  line('renderer: per new line, handler+layout median / p95 (ms)', (r) => `${f(r.renderer.data.live.totalMedianMs, 2)} / ${f(r.renderer.data.live.totalP95Ms, 2)}`),
  line('renderer: rows (cs.items) / children of cs.log', (r) => `${r.renderer.data.load.rows} / ${r.renderer.data.load.logChildren}`),
  line('renderer: DOM nodes in cs.log / in the document', (r) => `${r.renderer.data.load.logNodes} / ${r.renderer.data.load.docNodes}`),
  line('renderer: JS heap after GC, idle / loaded / +live / +scrollback (MB)', (r) => ['idle', 'loaded', 'after-live', 'after-scrollback'].map((k) => f(r.renderer.heap[k], 1)).join(' / ')),
  line('renderer process: working set, idle → loaded (MB)', (r) => `${f(r.renderer.metrics.idle.rendererWorkingSetKB / 1024)} → ${f(r.renderer.metrics.loaded.rendererWorkingSetKB / 1024)}`),
  line('main (Electron): RSS / heap, loaded (MB)', (r) => `${f(r.renderer.metrics.loaded.mainRssMB)} / ${f(r.renderer.metrics.loaded.mainHeapMB)}`),
  line('after live lines: rows / nodes in cs.log', (r) => `${r.renderer.data.live.rows} / ${r.renderer.data.live.logNodes}`),
  line('scroll to top: rows before → after, bubble in view moved (px)', (r) => `${r.renderer.data.scrollback.rowsBefore} → ${r.renderer.data.scrollback.rowsAfter}, ${r.renderer.data.scrollback.bubbleShiftPx}`),
];
console.log('\n' + head + '\n' + rows.join('\n'));
process.exit(0);
