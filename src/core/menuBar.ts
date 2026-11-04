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
