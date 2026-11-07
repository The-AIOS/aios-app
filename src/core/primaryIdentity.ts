/**
 * One vault, several computers: which Identity-table row is THIS computer's primary session.
 * Pure (no fs, no Electron). The App stores the choice machine-locally in ~/.aios/app.json; this
 * module only reads the table and applies the choice. Kept out of sessionName.ts, which is shared
 * byte-for-byte with Glass.
 */
/** One Identity-table row: the name as written (backticks stripped) and its Role cell. */
export interface IdentityRow { name: string; role: string }

/**
 * The Identity table's rows IN ORDER, names as written. Same table-finding rules as
 * identityNamesIn (under `## Identity`, or by its `Name | Role` header anywhere). A vault on several
 * computers keeps one row per computer's primary session, so the order matters: the first row is
 * the default primary, and each computer may choose another (choosePrimaryIdentity).
 */
export function identityRowsIn(text: string): IdentityRow[] {
  const out: IdentityRow[] = [];
  const lines = String(text ?? '').split(/\r?\n/);
  const cells = (l: string) => l.split('|').slice(1, -1).map((c) => c.replace(/`/g, '').trim());
  const isHeader = (l: string) => { const c = cells(l).map((x) => x.toLowerCase()); return c[0] === 'name' && c.includes('role'); };
  let start = lines.findIndex((l) => /^##\s+Identity/.test(l));
  if (start === -1) start = lines.findIndex((l) => l.startsWith('|') && isHeader(l)) - 1;
  if (start < -1) return out;
  let roleCol = 1;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) break;
    if (!line.startsWith('|')) { if (out.length) break; continue; }
    const c = cells(line);
    if ((c[0] ?? '').toLowerCase() === 'name') { const i = c.map((x) => x.toLowerCase()).indexOf('role'); roleCol = i > 0 ? i : 1; continue; }   // the header row, with or without a Role column
    const raw = c[0] ?? '';
    if (!raw || /^[ :-]+$/.test(raw)) continue;
    if (!out.some((r) => r.name.toLowerCase() === raw.toLowerCase())) out.push({ name: raw, role: c[roleCol] ?? '' });
  }
  return out;
}

/**
 * Which identity is THIS computer's primary. `stored` is the machine-local choice (empty = none).
 * A stored name no longer in the table falls back to the first row and reports `stale`, so Settings
 * can say so instead of quietly launching someone else.
 */
export function choosePrimaryIdentity(rows: readonly IdentityRow[], stored: string): { name: string; stale: boolean } {
  if (!rows.length) return { name: '', stale: false };
  const want = String(stored ?? '').trim().toLowerCase();
  if (!want) return { name: rows[0].name, stale: false };
  const hit = rows.find((r) => r.name.toLowerCase() === want);
  return hit ? { name: hit.name, stale: false } : { name: rows[0].name, stale: true };
}

