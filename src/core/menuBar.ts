/**
 * MENU-BAR MODEL — what the macOS menu-bar icon shows, as pure data (RFC: docs/rfcs/menu-bar.md).
 *
 * Two pieces, both free of Electron so they test without it:
 *
 *  - `sessionState` is the four-state reading the renderer's `statusInfo()` already paints on the
 *    tabs and the panel. The icon must say the same thing the panel says about a session, and the
 *    renderer is a classic script that cannot import this module, so its expressions are pinned to
 *    the renderer's copy by `menuBar.test.ts` — the same arrangement `BLOCKED_STATUS_RE` has.
 *  - `menuBarModel` turns the operator's live sessions into ordered rows and the waiting count.
 *    Labels are NOT decided here: the caller translates the state keys, so the model stays a
 *    stable value that can be compared tick to tick (the menu is rebuilt only when it changes).
 */
import { isBlockedStatus } from './attention';

export type SessionState = 'busy' | 'input' | 'error' | 'idle';

/** Pinned to `statusInfo()` in renderer/app.js. Order matters and matches it: busy, input, error, idle. */
export const BUSY_STATUSES: readonly string[] = ['busy', 'working', 'running'];
export const ERROR_STATUS_RE = /error|fail|crash/;

export function sessionState(raw: string | undefined | null): SessionState {
  const st = (raw || '').toLowerCase();
  if (BUSY_STATUSES.includes(st)) return 'busy';
  if (isBlockedStatus(st)) return 'input';
  if (ERROR_STATUS_RE.test(st)) return 'error';
  return 'idle';
}

export interface MenuBarSession { name: string; sessionId?: string; status: string }
export interface MenuBarRow { name: string; id: string; state: SessionState; group: number }
/** A tab group as the renderer reports it: its label, its palette colour name, its members' session names. */
export interface MenuBarGroup { name: string; color: string; members: string[] }
export interface MenuBarModel { rows: MenuBarRow[]; waiting: number; groups: { name: string; color: string }[] }

/** Sessions that need the operator first, then working, then errors, then ready; by name within each. */
const RANK: Record<SessionState, number> = { input: 0, busy: 1, error: 2, idle: 3 };

/**
 * Rows grouped like the App's tab groups (0.15.0 round 2): each group's sessions under it, in the groups' order, then the
 * sessions in no group. Within a block, the operator's attention order: waiting, working, errors, ready. `group` is the
 * index into `groups`, or -1. A group with no live session is left out, so the menu never shows an empty heading.
 */
export function menuBarModel(sessions: readonly MenuBarSession[], groupsIn: readonly MenuBarGroup[] = []): MenuBarModel {
  const named = groupsIn.filter((g) => g && Array.isArray(g.members));
  const groupOf = (name: string): number => named.findIndex((g) => g.members.includes(name));
  const all = sessions
    .filter((s) => s && s.name)
    .map((s) => ({ name: s.name, id: s.sessionId ?? '', state: sessionState(s.status), group: groupOf(s.name) }));
  const used = [...new Set(all.map((r) => r.group).filter((g) => g >= 0))].sort((a, b) => a - b);
  const remap = new Map(used.map((g, i) => [g, i]));
  const rows = all
    .map((r) => ({ ...r, group: r.group >= 0 ? remap.get(r.group)! : -1 }))
    .sort((a, b) => (a.group < 0 ? 1e6 : a.group) - (b.group < 0 ? 1e6 : b.group)
      || RANK[a.state] - RANK[b.state] || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const groups = used.map((g) => ({ name: String(named[g].name || ''), color: String(named[g].color || 'grey') }));
  return { rows, waiting: rows.filter((r) => r.state === 'input').length, groups };
}

/**
 * The tab-group palette as the menu's dots: the dark-theme `--tg-*` values in renderer/theme.css (Chrome's palette, the
 * bright ones, legible on both macOS menus), pinned there by `menuBar.test.ts`. An unknown name falls back to grey.
 */
export const GROUP_DOT_COLOR: Record<string, string> = {
  grey: '#dadce0', blue: '#8ab4f8', yellow: '#fdd663', green: '#81c995',
  pink: '#ff8bcb', purple: '#c58af9', cyan: '#78d9ec', orange: '#fcad70',
  coral: '#ff8a7d', indigo: '#a5adf6', lime: '#c5e478', brown: '#c8a887',
};
export function groupDotColor(name: string): string { return GROUP_DOT_COLOR[name] ?? GROUP_DOT_COLOR.grey; }

/** What the renderer sends, cleaned: at most 40 groups of 200 names, strings only. Anything else is dropped. */
export function sanitizeGroups(raw: unknown): MenuBarGroup[] {
  if (!Array.isArray(raw)) return [];
  const out: MenuBarGroup[] = [];
  for (const g of raw.slice(0, 40)) {
    if (!g || typeof g !== 'object') continue;
    const o = g as Record<string, unknown>;
    const members = Array.isArray(o.members) ? o.members.filter((m): m is string => typeof m === 'string' && !!m).slice(0, 200) : [];
    out.push({ name: typeof o.name === 'string' ? o.name.slice(0, 80) : '', color: typeof o.color === 'string' ? o.color : 'grey', members });
  }
  return out;
}

/** The text beside the icon: the waiting count, or nothing. Never "0" — an empty title is the calm state. */
export function menuBarTitle(model: MenuBarModel): string {
  return model.waiting > 0 ? String(model.waiting) : '';
}

/** Equality for "rebuild only when it changed" — rebuilding an open menu closes it under the pointer. */
export function sameModel(a: MenuBarModel | undefined, b: MenuBarModel): boolean {
  return !!a && JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The dot beside each session in the menu: the same four colours as the sidebar's state dots (`--st-idle`, `--st-busy`,
 * `--st-input`, `--st-error` in renderer/theme.css, pinned by `menuBar.test.ts`), instead of a word (0.15.0 round). The
 * dark-theme values: they are the bright ones, legible on both the light and the dark macOS menu.
 */
export const STATE_DOT_COLOR: Record<SessionState, string> = {
  idle: '#3ec77a',
  busy: '#f5a623',
  input: '#6cb0ff',
  error: '#e5484d',
};

/**
 * A filled circle as raw BGRA pixels (Electron's `nativeImage.createFromBitmap` layout on macOS and Windows), `size`
 * pixels square with an anti-aliased edge. Pure, so a test can read the pixels; the caller builds the image at 1x and 2x.
 */
export function dotBitmap(hex: string, size: number): Uint8Array {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`dotBitmap: not a colour: ${hex}`);
  const [r, g, b] = [m[1], m[2], m[3]].map((x) => parseInt(x, 16));
  const out = new Uint8Array(size * size * 4);
  const c = size / 2;
  const radius = size * 0.34;   // a dot, not a disc: room around it like the sidebar's 7 px dot in a row
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      const a = Math.max(0, Math.min(1, radius + 0.5 - d));   // 1 inside, a one-pixel ramp at the edge, 0 outside
      const i = (y * size + x) * 4;
      /* Premultiplied BGRA: the colour channels carry the alpha too, or the edge comes out as a light fringe. */
      out[i] = Math.round(b * a); out[i + 1] = Math.round(g * a); out[i + 2] = Math.round(r * a); out[i + 3] = Math.round(255 * a);
    }
  }
  return out;
}
