/* Which path-shaped strings in a terminal line become links, and what each link may do.
 *
 * Two levels, because the two gestures carry different risks:
 *   open   — ⌘-click previews the file INSIDE the app, which reads it. Gated by the allowed
 *            roots (framework root + workspace folders), exactly as before.
 *   reveal — ⌘⇧-click hands the path to Finder / Explorer, selected in its folder. Nothing is
 *            read, so the roots do not apply: an agent's deliverable in a temp folder, or a
 *            FOLDER it names, is exactly what the operator wants to see on the desktop, and
 *            before this neither became a link at all (no error, no underline — it read as
 *            "the app does not do that").
 *
 * Reveal-only targets must be written ABSOLUTE (or `~/…`). A relative token resolved against
 * the home folder would turn ordinary words that happen to name a folder into links.
 * Pure over the filesystem it is handed, so it is tested against real files. */
import * as path from 'node:path';

/* Reveal-only paths are stat'ed on HOVER, from text anyone could have printed, so a stat must
   never reach the network: a UNC or device path (`\\host\share`, `//host/x`, `\\?\`) makes
   Windows authenticate to that host (NTLM), and macOS's `/net/<host>` and `/Network/…` are automounts. Those
   only ever resolve through the allowed roots, as before. */
export function localAbsolute(v: string): string | null {
  const net = (x: string) => /^[\\/]{2}/.test(x) || /^\/(net|network)(\/|$)/i.test(x);
  if (!path.isAbsolute(v) || net(v)) return null;
  /* Checked again AFTER normalizing, and the normalized form is what gets stat'ed: `/./net`,
     `/a/../net` and `/NET` (APFS ignores case) are all /net. */
  const n = path.resolve(v);
  return net(n) ? null : n;
}

export interface LinkEnv {
  allowed: (abs: string) => boolean;
  /** Folders a relative candidate is resolved against, in order (pane cwd, framework, home). */
  bases: string[];
  home: string;
  stat: (abs: string) => { isFile(): boolean; isDirectory(): boolean } | null;
}

export interface LinkTargets {
  open: Record<string, string>;     // candidate → absolute file the viewer may read
  reveal: Record<string, string>;   // candidate → absolute file or folder Finder may show
}

/** The candidate as a filesystem string: trailing punctuation and a `:line(:col)` dropped, `~` expanded. */
export function normalizeCandidate(c: string, home: string): string {
  let v = String(c || '').trim().replace(/[)\]},.;:'"]+$/, '');
  v = v.replace(/:\d+(?::\d+)?$/, '');
  if (v.startsWith('~')) v = path.join(home, v.slice(1));
  return v;
}

export function resolveLinkTargets(cands: unknown, env: LinkEnv): LinkTargets {
  const out: LinkTargets = { open: {}, reveal: {} };
  for (const c of (Array.isArray(cands) ? cands : []).slice(0, 24)) {
    try {
      const v = normalizeCandidate(String(c), env.home);
      if (!v) continue;
      const absolute = path.isAbsolute(v);
      const tries = absolute ? [v] : env.bases.map((b) => path.resolve(b, v));
      for (const abs of tries) {
        if (!env.allowed(abs)) continue;
        const st = env.stat(abs);
        if (st && st.isFile()) { out.open[c] = abs; break; }
      }
      const local = out.open[c] || !absolute ? null : localAbsolute(v);
      if (!local) continue;
      const st = env.stat(local);
      if (st && (st.isFile() || st.isDirectory())) out.reveal[c] = local;
    } catch { /* skip */ }
  }
  return out;
}

/** What `shell:reveal` may show: the normalized form of a local absolute path that exists. */
export function revealable(p: unknown, stat: LinkEnv['stat']): string | null {
  const local = typeof p === 'string' ? localAbsolute(p) : null;
  return local && stat(local) !== null ? local : null;
}
