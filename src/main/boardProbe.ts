/**
 * #91 — the board isolation probe: a HOSTILE board, loaded in real Chromium, that tries every way out
 * a static page has, plus the positive controls that prove the measurement is live. Shared by the
 * smoke gate (the real App, its real card) and `src/test/boardIsolation.e2e.test.ts` (a bare window,
 * plus a control run with the protections removed that MUST reach the network).
 *
 * Why real Chromium: CSP, iframe sandboxing and navigation are enforced by the browser, and a test
 * that reads source can only say the header is spelled right. Two independent witnesses decide:
 *  · a local HTTP server counts every request that arrives (the network, as the network sees it);
 *  · the session's onBeforeRequest records every URL the page asked for in any scheme (file:, http:,
 *    other boards), so a request that never reaches a socket is still seen.
 */
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { WebContents } from 'electron';
import { boardId, BOARD_SCHEME } from '../core/boards';

/** A 1×1 transparent PNG: the positive control's image must be a real image. */
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

export interface HitServer { port: number; hits: string[]; close(): Promise<void>; }

export function startHitServer(): Promise<HitServer> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => { hits.push(req.url || '?'); res.writeHead(204); res.end(); });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ port, hits, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

export interface HostileFixture {
  root: string;          // the boards folder to point AIOS_BOARDS_DIR at
  name: string;          // the hostile board
  dir: string;           // its folder
  otherName: string;     // a second board it must not reach
  secret: string;        // a file OUTSIDE every board folder
  ownFiles: string[];    // what MUST be served (positive control)
  net: string;           // the hit server's origin
}

/** Writes the fixture under a fresh temp folder. `port` is the hit server's. */
export function writeHostileBoard(port: number): HostileFixture {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aios-board-probe-')));
  const root = path.join(base, 'boards');
  const name = 'hostile';
  const otherName = 'neighbour';
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(root, otherName), { recursive: true });
  const secret = path.join(base, 'secret.png');
  fs.writeFileSync(secret, PIXEL);
  /* The neighbour has files but NO index.html: the handler would still serve them if asked (it maps any
     folder), which is what the cross-board probes need, but it is not a board, so the App draws no
     card for it. With an index.html the App's own card for it loaded it, and the smoke gate counted
     that legitimate load as the hostile board's doing. */
  fs.writeFileSync(path.join(root, otherName, 'other.css'), 'p { color: red; }');
  fs.writeFileSync(path.join(root, otherName, 'pixel.png'), PIXEL);
  fs.writeFileSync(path.join(dir, 'pixel.png'), PIXEL);
  fs.writeFileSync(path.join(dir, 'style.css'), 'body { font: 12px sans-serif; }');
  fs.writeFileSync(path.join(dir, 'probe.js'), `new Image().src = 'http://127.0.0.1:${port}/script-file';`);
  // a symlink inside the folder that points out of it: must be refused by the realpath check
  try { fs.symlinkSync(secret, path.join(dir, 'link.png')); } catch { /* no symlinks here; the other probes still run */ }
  const net = `http://127.0.0.1:${port}`;
  const other = `${BOARD_SCHEME}://${boardId(otherName)}`;
  fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="4;url=${net}/meta-refresh">
<link rel="stylesheet" href="style.css">
<link rel="stylesheet" href="${net}/stylesheet">
<link rel="prefetch" href="${net}/prefetch">
<link rel="preload" as="image" href="${net}/preload">
<link rel="icon" href="${net}/favicon">
<link rel="preconnect" href="${net}/preconnect">
<link rel="dns-prefetch" href="${net}/dns-prefetch">
<link rel="modulepreload" href="${net}/modulepreload">
<script src="probe.js"></script>
<script src="${net}/script-src"></script>
<script>new Image().src = '${net}/inline-script'; fetch('${net}/fetch');</script>
<style>@import url("${net}/import"); .bg { background: url("${net}/css-bg"); }</style>
</head><body>
<div class="bg">board</div>
<img src="pixel.png" alt="">
<img src="link.png" alt="">
<img src="${net}/img" alt="">
<img src="file://${secret}" alt="">
<img src="${other}/pixel.png" alt="">
<img srcset="${net}/srcset 1x" alt="">
<picture><source srcset="${net}/picture"><img alt=""></picture>
<iframe src="${net}/iframe"></iframe>
<iframe src="${other}/index.html"></iframe>
<link rel="stylesheet" href="${other}/other.css">
<object data="${net}/object"></object>
<embed src="${net}/embed">
<audio src="${net}/audio" autoplay></audio>
<video src="${net}/video" poster="${net}/poster" autoplay></video>
<svg width="1" height="1"><image href="${net}/svg-image" width="1" height="1"/></svg>
<iframe srcdoc="<meta http-equiv='refresh' content='0;url=${net}/srcdoc-refresh'>"></iframe>
<!-- the two vectors that need a click: the e2e harness clicks them (CLICK_POINTS), the smoke does not.
     The form lives in its own frame so that, in the unprotected control, submitting it does not take
     the link away before it is clicked; the meta refresh waits 4 s for the same reason. -->
<a href="${net}/link" ping="${net}/ping" style="position:fixed;left:0;top:0;width:300px;height:80px;display:block;background:#eee;z-index:9">link</a>
<iframe style="position:fixed;left:0;top:100px;width:320px;height:100px;border:0;z-index:9" srcdoc="<body style='margin:0'><form action='${net}/form' method='get'><input type='hidden' name='q' value='x'><button style='width:300px;height:80px'>submit</button></form>"></iframe>
</body></html>
`);
  return { root, name, dir, otherName, secret, ownFiles: ['index.html', 'style.css', 'pixel.png'], net };
}

/** Where the harness clicks, in the board frame's coordinates (the frame sits at 0,0): the form's button
 *  first (its own frame), then the link (which navigates the board frame itself). */
export const CLICK_POINTS: ReadonlyArray<[number, number]> = [[150, 140], [150, 40]];

export interface ProbeResult {
  hits: string[];             // requests that reached the network
  requested: string[];        // every URL the session was asked for while the probe ran
  served: string[];           // files the board protocol actually read (relative to the board folder, or absolute if outside)
  blockedNavigations: string[];
  ok: boolean;
  why: string[];              // empty when ok
}

/**
 * Judge a run. `requested` is filtered to what the board could have caused: the App's own page loads
 * file:// resources and may call its own services, none of which are the board's doing. Every URL the
 * hostile page names points at the hit server, the secret, or the other board, so those are the ones
 * that count.
 */
export function judgeProbe(fx: HostileFixture, r: { hits: string[]; requested: string[]; served: string[]; blockedNavigations: string[] }): ProbeResult {
  const why: string[] = [];
  if (r.hits.length) why.push(`reached the network: ${r.hits.join(', ')}`);
  const own = `${BOARD_SCHEME}://${boardId(fx.name)}/`;
  const foreign = r.requested.filter((u) => u.startsWith(fx.net) || u.startsWith(`file://${fx.secret}`) || (u.startsWith(`${BOARD_SCHEME}://`) && !u.startsWith(own)));
  if (foreign.length) why.push(`asked for something outside its folder: ${foreign.join(', ')}`);
  const outside = r.served.filter((f) => !f.startsWith(fx.dir + path.sep));
  if (outside.length) why.push(`the protocol served a file outside the board: ${outside.join(', ')}`);
  const servedRel = r.served.map((f) => path.relative(fx.dir, f));
  if (servedRel.includes('probe.js')) why.push('the protocol served a script');
  const missing = fx.ownFiles.filter((f) => !servedRel.includes(f));
  if (missing.length) why.push(`POSITIVE CONTROL FAILED, its own files were not loaded: ${missing.join(', ')} (the measurement is not live)`);
  return { ...r, ok: why.length === 0, why };
}

/** Records every URL a WebContents' session is asked for. Returns the stop function. One listener per
 *  session is all Electron allows, so this must not run alongside another onBeforeRequest. */
export function recordRequests(wc: WebContents, into: string[]): () => void {
  const wr = wc.session.webRequest;
  wr.onBeforeRequest((d, cb) => { into.push(d.url); cb({}); });
  return () => wr.onBeforeRequest(null);
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
