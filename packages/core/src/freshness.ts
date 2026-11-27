/**
 * Framework freshness — the update indicator's decision, shared by the App and Glass, matching
 * canonical's hooks/freshness-probe.sh (release/2026-10-11, 2fae78f):
 *   synced · BEHIND · TESTING <branch> · unknown
 * TESTING means the vault is on a NON-DEFAULT branch: the tracker carries `ref=<branch>`, or its
 * `hash=` is the tip of a branch other than the default. Such a vault is AHEAD of main, so the
 * indicator must never offer (or run) an update for it — that would pull it back to main. Before
 * this, the App compared the hash with the remote HEAD only and read a vault on a release branch as
 * "update available". Pure: the caller runs `git ls-remote --symref <url>`.
 */
export interface RemoteRefs { defaultBranch?: string; defaultSha?: string; heads: Map<string, string> }

/** Parse `git ls-remote --symref <url>` output (the symref line, HEAD, then refs/heads/*). */
export function parseLsRemote(out: string): RemoteRefs {
  const heads = new Map<string, string>();
  let defaultBranch: string | undefined;
  let defaultSha: string | undefined;
  for (const line of String(out ?? '').split('\n')) {
    const sym = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/.exec(line.trim());
    if (sym) { defaultBranch = sym[1]; continue; }
    const m = /^([0-9a-f]{7,40})\s+(\S+)$/.exec(line.trim());
    if (!m) continue;
    if (m[2] === 'HEAD') defaultSha = m[1];
    else if (m[2].startsWith('refs/heads/')) heads.set(m[2].slice('refs/heads/'.length), m[1]);
  }
  if (!defaultSha && defaultBranch) defaultSha = heads.get(defaultBranch);
  return { defaultBranch, defaultSha, heads };
}

export type Freshness =
  | { state: 'up-to-date' }
  | { state: 'available' }
  | { state: 'testing'; branch: string }
  | { state: 'unknown' };

export function freshness(tracker: { hash?: string; ref?: string }, remote: RemoteRefs): Freshness {
  const hash = (tracker.hash || '').trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(hash) || !remote.defaultSha) return { state: 'unknown' };
  const ref = (tracker.ref || '').trim();
  if (ref && ref !== remote.defaultBranch) return { state: 'testing', branch: ref };
  if (remote.defaultSha.startsWith(hash)) return { state: 'up-to-date' };
  for (const [branch, sha] of remote.heads) {
    if (branch !== remote.defaultBranch && sha.startsWith(hash)) return { state: 'testing', branch };
  }
  return { state: 'available' };
}
