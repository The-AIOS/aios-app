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
export interface MenuBarRow { name: string; id: string; state: SessionState }
export interface MenuBarModel { rows: MenuBarRow[]; waiting: number }

/** Sessions that need the operator first, then working, then errors, then ready; by name within each. */
const RANK: Record<SessionState, number> = { input: 0, busy: 1, error: 2, idle: 3 };

export function menuBarModel(sessions: readonly MenuBarSession[]): MenuBarModel {
  const rows = sessions
    .filter((s) => s && s.name)
    .map((s) => ({ name: s.name, id: s.sessionId ?? '', state: sessionState(s.status) }))
    .sort((a, b) => RANK[a.state] - RANK[b.state] || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { rows, waiting: rows.filter((r) => r.state === 'input').length };
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
