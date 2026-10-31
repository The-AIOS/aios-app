/**
 * Reading the framework's account list. Glass over `claude-identity.sh switch --availability`:
 * the script owns the list, the order and the decision of who can take you, and this only
 * reads its answer. Two surfaces used to carry a parser each for USER.md, and Glass its own
 * round-robin, so the button could offer an account the rotation itself would pass over.
 *
 * Pure, so both surfaces share it and it runs without a framework. Shared with the AIOS App
 * through `npm run sync-core`.
 */

export interface AccountRow {
  email: string;
  alias: string;
  /** active · available · capped · expired · not-captured · out-of-rotation, or `unknown` when
   *  an older framework can only give the list. A state this file has not met passes through. */
  state: string;
  /** The script's own sentence: usage, and when the account renews. */
  detail: string;
  rotation: boolean;
}

/** The rows in the script's JSON, or null when it is not that shape: an unreadable answer must
 *  read as "could not ask", never as "no accounts". */
export function parseAvailability(text: string): AccountRow[] | null {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(data)) return null;
  const out: AccountRow[] = [];
  for (const raw of data) {
    const r = raw as Record<string, unknown> | null;
    if (!r || typeof r.email !== 'string' || !r.email || typeof r.state !== 'string') return null;
    out.push({
      email: r.email,
      alias: typeof r.alias === 'string' ? r.alias : '',
      state: r.state,
      detail: typeof r.detail === 'string' ? r.detail : '',
      rotation: r.rotation !== false,
    });
  }
  return out;
}

/** An older framework keeps its list in USER.md → "## Anthropic accounts" and has no
 *  `--availability` to ask. Surfaces and framework update separately, so this stays until
 *  no supported framework needs it. Nothing is known about these accounts but their names. */
export function rowsFromUserMd(md: string, current: string): AccountRow[] {
  const out: AccountRow[] = [];
  let inSection = false;
  for (const line of md.split(/\r?\n/)) {
    if (/^##\s+Anthropic accounts/i.test(line)) { inSection = true; continue; }
    if (inSection && /^##\s/.test(line)) break;
    if (!inSection) continue;
    const m = /^\s*\d+\.\s*`([^`\s]+@[^`\s]+)`/.exec(line);
    if (!m) continue;
    const a = /alias\s+\*\*([^*]+)\*\*/.exec(line);
    out.push({
      email: m[1], alias: a ? a[1].trim() : '', detail: '', rotation: true,
      state: m[1] === current ? 'active' : 'unknown',
    });
  }
  return out;
}

/** Where a swap should go. The first account the script calls available, in its order. With
 *  an older framework nothing is known, so it stays the next one down the list, as it was. */
export function nextDestination(rows: AccountRow[], current: string): string {
  if (rows.some((r) => r.state === 'unknown')) {
    const others = rows.filter((r) => r.email !== current);
    if (!others.length) return '';
    const i = rows.findIndex((r) => r.email === current);
    return i < 0 ? others[0].email : rows[(i + 1) % rows.length].email;
  }
  const hit = rows.find((r) => r.state === 'available' && r.rotation && r.email !== current);
  return hit ? hit.email : '';
}

/** Whether a person may pick this account by hand. Expired ends at a login screen, and an
 *  account never captured cannot be restored. A capped one works, and is theirs to choose. */
export function canSwitchTo(row: AccountRow): boolean {
  return row.state !== 'expired' && row.state !== 'not-captured' && row.state !== 'active';
}

/** The account's short name, for a menu. */
export function rowLabel(row: AccountRow): string {
  return row.alias ? `${row.alias} (${row.email})` : row.email;
}
