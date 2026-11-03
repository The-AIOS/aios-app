/**
 * #91 — sidebar boards, the main-process half: list `~/.aios/boards`, serve each board through the
 * `aios-board:` protocol, and stop board frames from navigating. The rules themselves are pure and
 * live in ../core/boards.ts; this file only touches the disk and Electron.
 *
 * Read only. The App never writes into the boards folder.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Protocol, WebContents } from 'electron';
import {
  BOARD_SCHEME, BOARD_MIME, BOARD_MAX_BYTES, boardId, boardRelPath, boardResponseHeaders,
  boardRows, boardNavigationAllowed, isBoardName, type BoardEntry, type BoardRow,
} from '../core/boards';

/** `$AIOS_BOARDS_DIR` or `~/.aios/boards`, read at call time so tests and the smoke can point it at a fixture. */
export function boardsDir(): string {
  return process.env.AIOS_BOARDS_DIR || path.join(os.homedir(), '.aios', 'boards');
}

function readEntries(dir: string): BoardEntry[] {
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return []; }   // no folder → no boards
  const out: BoardEntry[] = [];
  for (const name of names) {
    if (!isBoardName(name)) continue;
    const folder = path.join(dir, name);
    try { if (!fs.statSync(folder).isDirectory()) continue; } catch { continue; }
    const e: BoardEntry = { name };
    try {
      const st = fs.statSync(path.join(folder, 'index.html'));
      if (st.isFile()) e.indexMtimeMs = st.mtimeMs;
    } catch { /* not a board */ }
    const cfg = path.join(folder, 'board.json');
    if (fs.existsSync(cfg)) {
      try { e.boardJson = fs.readFileSync(cfg, 'utf8'); } catch (err) { e.boardJsonError = `board.json: ${(err as Error).message}`.slice(0, 160); }
    }
    out.push(e);
  }
  return out;
}

/** The sidebar's rows. Cheap (a readdir and two stats per folder), so the renderer can poll it. */
export function listBoards(now = Date.now()): BoardRow[] {
  return boardRows(readEntries(boardsDir()), now);
}

/** host → the board's real folder, or null. Re-read per request: boards come and go while the App runs. */
function boardFolderFor(host: string): { name: string; folder: string } | null {
  const dir = boardsDir();
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return null; }
  const name = names.find((n) => isBoardName(n) && boardId(n) === host);
  if (!name) return null;
  try { return { name, folder: fs.realpathSync(path.join(dir, name)) }; } catch { return null; }
}

const refuse = (status: number): Response => new Response(null, { status, headers: { 'Cache-Control': 'no-store' } });

/**
 * Serve one request. Exported so the isolation test drives the SAME function the App installs.
 * `onServe` is a test hook: it is told every path that was actually read from disk.
 */
export async function serveBoardRequest(req: Request, onServe?: (file: string) => void): Promise<Response> {
  if (req.method !== 'GET') return refuse(405);
  let url: URL;
  try { url = new URL(req.url); } catch { return refuse(400); }
  const board = boardFolderFor(url.host);
  if (!board) return refuse(404);
  const { name, folder } = board;
  const rel = boardRelPath(url.pathname);
  if (!rel) return refuse(403);
  /* The realpath half of the confinement: a symlink inside the folder that points out of it is
     refused, as is anything that is not a plain file. The resolved path must pass the same rules as
     the requested one (a `pic.png` linking to `.secret.json` inside the folder is still a dot-file
     and not an asset type), and the type is the resolved file's. */
  let real: string;
  try { real = fs.realpathSync(path.join(folder, rel)); } catch { return refuse(404); }
  if (!real.startsWith(folder + path.sep)) return refuse(403);
  if (boardRelPath('/' + path.relative(folder, real).split(path.sep).join('/')) === null) return refuse(403);
  const mime = BOARD_MIME[path.extname(real).toLowerCase()];
  if (!mime) return refuse(403);
  /* Read through a descriptor and check it is the file that was vetted: between the realpath above
     and the read, a writer could swap a folder for a symlink and the path would re-resolve elsewhere.
     Only someone who can already write the board could try that, but the check costs one fstat. */
  let body: Buffer;
  let fd: number | undefined;
  try {
    // non-blocking: a FIFO named like a png would otherwise hang the main process on open()
    fd = fs.openSync(real, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    const st = fs.fstatSync(fd);
    const again = fs.statSync(fs.realpathSync(real));
    if (!st.isFile() || st.size > BOARD_MAX_BYTES || st.ino !== again.ino || st.dev !== again.dev
      || !fs.realpathSync(real).startsWith(folder + path.sep)) return refuse(403);
    body = fs.readFileSync(fd);
  } catch { return refuse(404); }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* closed */ } } }
  onServe?.(real);
  return new Response(new Uint8Array(body), { status: 200, headers: boardResponseHeaders(name, mime) });
}

/**
 * Must run before `app.ready`: the scheme is STANDARD (relative URLs inside a board resolve against
 * its folder) and SECURE (no mixed-content downgrade), and nothing else — no fetch API, no CORS, no
 * CSP bypass, no service workers.
 */
export function registerBoardScheme(protocol: Protocol): void {
  protocol.registerSchemesAsPrivileged([{ scheme: BOARD_SCHEME, privileges: { standard: true, secure: true } }]);
}

/** After `app.ready`, on the DEFAULT session only. Browser panes use their own partition, so a web
 *  page opened in one cannot reach a board at all. */
export function installBoardProtocol(protocol: Protocol, onServe?: (file: string) => void): void {
  protocol.handle(BOARD_SCHEME, (req) => serveBoardRequest(req, onServe));
}

/**
 * Navigation stopped. `will-navigate` only sees the top frame (which the window already pins to the
 * App's page), so board frames need `will-frame-navigate`. `onBlock` is a test hook.
 */
export function guardBoardNavigation(wc: WebContents, onBlock?: (from: string, to: string) => void): void {
  wc.on('will-frame-navigate', (e) => {
    const frame = e.frame;
    const from = frame?.url ?? '';
    const top = wc.mainFrame;
    const ctx = {
      frameIsChildOfTop: !!frame && !!frame.parent && frame.parent.frameTreeNodeId === top.frameTreeNodeId,
      initiatorIsTop: !!e.initiator && e.initiator.frameTreeNodeId === top.frameTreeNodeId,
    };
    if (boardNavigationAllowed(from, e.url, ctx)) return;
    e.preventDefault();
    onBlock?.(from, e.url);
  });
}
