/**
 * #91 — sidebar BOARDS: one card per `~/.aios/boards/<name>/index.html`, a static page the operator's
 * own tooling writes. This is the sidebar's `custom/` slot: the App lists boards and shows them, and
 * knows nothing about what they mean. Pure: main reads the directory and serves the files; this
 * decides what is a board, when it is stale, what a board may load and where it may go.
 *
 * Contract (docs/rfcs/sidebar-boards.md):
 *  · one folder per card; a folder without `index.html` is not a board; dot-folders are ignored.
 *  · optional `board.json`: { title?: string, valid_for?: seconds } — default title is the folder
 *    name, default valid_for is one hour. A malformed board.json is reported on the card, never a
 *    reason to hide the board: a broken writer is news, as it is for Health.
 *  · stale = index.html older than valid_for → drawn like an overdue Health job.
 *  · the App never writes into the boards folder.
 *
 * Isolation, the part #91 was about. The HTML viewer that opens exported deliverables lets scripts
 * run, does not block the network and loads from file://, which is right for a file the operator
 * opens on purpose and wrong for one that loads on its own every time the App starts. Boards get
 * their own rules, each enforced twice:
 *  · no scripts — the frame is sandbox="" AND the response's CSP carries `sandbox` + default-src 'none';
 *  · no network, nothing outside the folder — served by the `aios-board:` protocol (never file://),
 *    whose handler only serves files inside that board's folder, AND a CSP that allows images,
 *    styles and fonts from that board's own origin only;
 *  · navigation stopped — the sandbox grants no navigation, popups or forms, AND main refuses every
 *    navigation of a board frame except reloading its own index.html, and every navigation INTO a
 *    board except the App's own page mounting a card.
 */
import { createHash } from 'crypto';

export const BOARD_SCHEME = 'aios-board';
export const DEFAULT_VALID_FOR_S = 3600;

/** Each board is its own origin, so one board cannot pull another's files. The host is derived from
 *  the folder name rather than BEING it: standard-scheme hosts are lower-cased and limited to DNS
 *  characters, and a folder name is neither. A hash is fixed-length, case-safe and never ambiguous. */
export function boardId(name: string): string {
  return createHash('sha256').update(name, 'utf8').digest('hex').slice(0, 32);
}

export const boardOrigin = (name: string): string => `${BOARD_SCHEME}://${boardId(name)}`;

/** `v` is the file's mtime: a changed board gets a new URL (and so a reload), an unchanged one keeps
 *  its URL and is never reloaded. */
export const boardUrl = (name: string, mtimeMs: number): string =>
  `${boardOrigin(name)}/index.html?v=${Math.floor(mtimeMs)}`;

/** A folder name that can be a board: not hidden, not a path, not absurd. */
export function isBoardName(name: string): boolean {
  return !!name && name.length <= 128 && !name.startsWith('.') && !/[\\/\u0000]/.test(name);
}

export interface BoardEntry {
  name: string;
  indexMtimeMs?: number;      // undefined → no index.html (not a board)
  boardJson?: string;         // raw board.json text, if the file exists
  boardJsonError?: string;    // board.json existed but could not be read
}

export type BoardStatus = 'fresh' | 'stale';

export interface BoardRow {
  name: string;
  title: string;
  url: string;
  mtimeMs: number;
  validForS: number;
  status: BoardStatus;
  /** board.json problem, shown on the card; the board still renders. */
  configError?: string;
}

/** board.json → { title, validForS } or an error. Unknown keys are ignored (room for later fields). */
export function parseBoardJson(text: string): { title?: string; validForS?: number; error?: string } {
  let rec: unknown;
  try { rec = JSON.parse(text); } catch (e) { return { error: `board.json: ${(e as Error).message}`.slice(0, 160) }; }
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return { error: 'board.json: not an object' };
  const r = rec as Record<string, unknown>;
  const out: { title?: string; validForS?: number; error?: string } = {};
  if ('title' in r) {
    if (typeof r.title === 'string' && r.title.trim()) out.title = r.title.trim().slice(0, 80);
    else out.error = 'board.json: title must be a non-empty string';
  }
  if ('valid_for' in r) {
    const v = r.valid_for;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out.validForS = v;
    else out.error = 'board.json: valid_for must be a positive number of seconds';
  }
  return out;
}

/** One row per board, sorted by name. Folders without index.html are not boards and get no row. */
export function boardRows(entries: ReadonlyArray<BoardEntry>, now: number): BoardRow[] {
  const out: BoardRow[] = [];
  for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!isBoardName(e.name) || e.indexMtimeMs === undefined) continue;
    const cfg = e.boardJson !== undefined ? parseBoardJson(e.boardJson) : {};
    const validForS = cfg.validForS ?? DEFAULT_VALID_FOR_S;
    const row: BoardRow = {
      name: e.name,
      title: cfg.title ?? e.name,
      url: boardUrl(e.name, e.indexMtimeMs),
      mtimeMs: e.indexMtimeMs,
      validForS,
      status: now - e.indexMtimeMs > validForS * 1000 ? 'stale' : 'fresh',
    };
    const err = e.boardJsonError ?? cfg.error;
    if (err) row.configError = err;
    out.push(row);
  }
  return out;
}

/* ── what the protocol serves ─────────────────────────────────────────────────────────────── */

/** Static assets only. Anything else (scripts, json, an executable, a symlink to one) is refused even
 *  inside the folder: a board is a page, not a file share. */
export const BOARD_MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
};

export const BOARD_MAX_BYTES = 8 * 1024 * 1024;

/** The request's path → a relative path inside the board folder, or null. Lexical half of the
 *  confinement; main adds the realpath half (symlinks) before reading anything. */
export function boardRelPath(urlPathname: string): string | null {
  let p: string;
  try { p = decodeURIComponent(urlPathname); } catch { return null; }
  if (p === '' || p === '/') p = '/index.html';
  if (!p.startsWith('/') || /[\\\u0000]/.test(p)) return null;
  const parts = p.slice(1).split('/');
  if (parts.some((s) => s === '' || s === '.' || s === '..' || s.startsWith('.'))) return null;
  const ext = (parts[parts.length - 1].match(/\.[^.]+$/) || [''])[0].toLowerCase();
  if (!(ext in BOARD_MIME)) return null;
  return parts.join('/');
}

/** The policy every board response carries. `sandbox` in the header means the page is sandboxed even
 *  if it is ever loaded outside the card's frame. Only the board's own origin is allowed, for the
 *  three resource kinds a static page needs; everything else (network, file:, other boards, frames,
 *  forms, scripts) falls to default-src 'none'. */
export function boardCsp(name: string): string {
  const self = boardOrigin(name);
  return [
    "default-src 'none'",
    `img-src ${self} data:`,
    `style-src ${self} 'unsafe-inline'`,
    `font-src ${self} data:`,
    "form-action 'none'",
    "base-uri 'none'",
    'sandbox',
  ].join('; ');
}

export function boardResponseHeaders(name: string, mime: string): Record<string, string> {
  return {
    'Content-Type': mime,
    'Content-Security-Policy': boardCsp(name),
    'X-Content-Type-Options': 'nosniff',
    'X-DNS-Prefetch-Control': 'off',      // CSP does not govern DNS prefetch; a lookup is still a way out
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',          // a board changes every few minutes; a cached copy is a lie
  };
}

/* ── where a board frame may go ───────────────────────────────────────────────────────────── */

const isBoardUrl = (u: string): boolean => u.startsWith(`${BOARD_SCHEME}://`);
const hostOf = (u: string): string | null => { try { return new URL(u).host; } catch { return null; } };
const pathOf = (u: string): string | null => { try { return new URL(u).pathname; } catch { return null; } };

/** Who is asking, for a navigation INTO a board. Main fills it from Electron's frame tree. */
export interface BoardNavContext {
  /** the navigating frame is a direct child of the window's top frame (where the App's cards live) */
  frameIsChildOfTop: boolean;
  /** the navigation was started by the top frame (the App's own page), not by the frame or a page inside it */
  initiatorIsTop: boolean;
}

/**
 * May a frame currently showing `fromUrl` navigate to `toUrl`?
 *  · neither side is a board → not this rule's business (true);
 *  · a board frame → only to its own index.html (the card reloading it with a new `v`);
 *  · into a board from anywhere else → only a fresh frame (about:blank) that is a direct child of the
 *    App's page, navigated BY the App's page: the card mounting its frame. A page in the HTML viewer
 *    (scripts on) creating its own frame and pointing it at a board is refused, as is any web page.
 */
export function boardNavigationAllowed(fromUrl: string, toUrl: string, ctx?: BoardNavContext): boolean {
  const fromBoard = isBoardUrl(fromUrl);
  const toBoard = isBoardUrl(toUrl);
  if (!fromBoard && !toBoard) return true;
  if (!fromBoard) return (fromUrl === '' || fromUrl === 'about:blank') && !!ctx && ctx.frameIsChildOfTop && ctx.initiatorIsTop;
  if (!toBoard) return false;
  const p = pathOf(toUrl);
  return hostOf(fromUrl) === hostOf(toUrl) && (p === '/index.html' || p === '/');
}
