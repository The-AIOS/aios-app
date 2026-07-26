/**
 * AI-58 — Explorer per-folder sort (SHARED logic).
 *
 * This module is intentionally PURE (no `vscode`, no `fs`): the comparator and
 * the per-folder-pref map helpers are the single source of truth for BOTH
 * fronts — the Glass extension's Explorer webview AND the AIOS App's file
 * sidebar (AI-53 topology). Each surface wires its own affordance (the header
 * sort control) and its own persistence sink, but the SORT + the pref shape are
 * written once here and reused. The `.glass/` state file (App-owned glass-UI
 * namespace) roams the same `filesFolderSort` map to both fronts.
 *
 * Two modes, both with folders-first (standard tree muscle memory):
 *   - `name`  — A→Z, locale-aware, numeric-prefix friendly ("00 - " sorts right)
 *   - `mtime` — most-recently-modified first (the file you just saved on top)
 *
 * The pref is keyed by a WORKSPACE-ROOT path and applied to that root's whole
 * subtree — e.g. `~/code` alphabetical (stable), `~/Downloads` newest
 * (alphabetical there is painful). Vault + framework trees keep `name` in v1.
 */

export type SortMode = 'name' | 'mtime';

/** The two shipped modes, in menu order. */
export const SORT_MODES: readonly SortMode[] = ['name', 'mtime'] as const;

/** Default when a folder has no stored preference. */
export const DEFAULT_SORT: SortMode = 'name';

/** The glass-state key holding `{ [folderPath]: SortMode }` — per-folder overrides
 *  at ANY depth (roams via `.glass/`). A dir uses its closest-ancestor override. */
export const FOLDER_SORT_KEY = 'filesFolderSort';

/** The glass-state key holding the single global default sort (`name` | `mtime`).
 *  Folders without an override follow this; the master button resets all to it. */
export const MASTER_SORT_KEY = 'filesMasterSort';

/** Coerce any stored/received value to a valid mode (defensive against drift). */
export function normalizeSortMode(v: unknown): SortMode {
  return v === 'mtime' ? 'mtime' : 'name';
}

/** The minimum an entry needs to be sorted — surfaces map their rows onto this. */
export interface SortableEntry {
  name: string;
  dir: boolean;
  /** `stat.mtimeMs` (0 if unknown — sorts last under `mtime`). */
  mtime: number;
}

/**
 * The canonical comparator. Folders always precede files; WITHIN each group the
 * chosen mode applies. `name` is locale + numeric aware; `mtime` is newest-first
 * with a stable name tiebreak so equal-mtime entries don't jitter.
 */
export function compareEntries(a: SortableEntry, b: SortableEntry, mode: SortMode): number {
  if (a.dir !== b.dir) return a.dir ? -1 : 1; // folders first, both modes
  if (mode === 'mtime') {
    const d = (b.mtime || 0) - (a.mtime || 0); // most-recent first
    if (d !== 0) return d;
  }
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}

/** Sort a list in place-safe fashion (returns the same array, sorted). */
export function sortEntries<T extends SortableEntry>(entries: T[], mode: SortMode): T[] {
  return entries.sort((a, b) => compareEntries(a, b, mode));
}

/** The pref map — a plain object safe to JSON-persist in `.glass/state.json`. */
export type FolderSortMap = Record<string, SortMode>;

/** Read the mode for `rootPath` from a pref map, defaulting to `name`. */
export function getFolderSort(map: FolderSortMap | undefined, rootPath: string): SortMode {
  return normalizeSortMode(map?.[rootPath]);
}

/**
 * Return a NEW map with `folderPath` set to `mode` (immutable update — the caller
 * persists the result). Stores the override EXPLICITLY (no prune-on-`name`): with a
 * master default, a `name` override must persist even when the master is `mtime`.
 */
export function setFolderSort(map: FolderSortMap | undefined, folderPath: string, mode: SortMode): FolderSortMap {
  const next: FolderSortMap = { ...(map || {}) };
  next[folderPath] = mode;
  return next;
}

/**
 * Resolve the effective sort for `dir`: its closest-ancestor override (incl. itself)
 * among the override keys, else the master default. `owningRoot` does longest-match,
 * so a subfolder override beats its parent's — per-folder sorting works at any depth.
 */
export function resolveSort(overrides: FolderSortMap, dir: string, master: SortMode): SortMode {
  const owner = owningRoot(Object.keys(overrides), dir);
  const ov = owner ? overrides[owner] : undefined;
  return ov === 'name' || ov === 'mtime' ? ov : master;
}

/**
 * Given a list of override folder paths and a target directory, find which one
 * OWNS that directory (an override applies to its whole subtree). Longest-match
 * wins so a nested override beats an ancestor one. Returns undefined when the dir
 * is under no override folder (→ the master default applies).
 */
export function owningRoot(roots: readonly string[], dir: string): string | undefined {
  let best: string | undefined;
  for (const r of roots) {
    if (dir === r || dir.startsWith(r + '/')) {
      if (!best || r.length > best.length) best = r;
    }
  }
  return best;
}
