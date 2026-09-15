/**
 * Which `git` should the App run? — the decision, with no filesystem in it.
 *
 * WHY THIS EXISTS. A packaged macOS app launched from Finder inherits a MINIMAL PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`) — not the operator's shell PATH. On macOS `/usr/bin/git` is
 * not git: it is the Xcode Command Line Tools **shim**, which exists, is executable, and exits
 * non-zero with *"You have not agreed to the Xcode license agreements"* until someone runs
 * `xcodebuild -license`. So `execFile('git', …)` FINDS something and that something fails.
 *
 * Measured on a live machine 2026-09-15: every one of the App's git calls was failing this way
 * while the same commands worked in any terminal, because a terminal's PATH reaches Homebrew
 * first. The visible symptom was the framework pill reading *"✓ synced {date}"* — the fallback
 * for "the remote check could not run" — which an operator reasonably reads as success.
 *
 * EXISTENCE IS NOT ENOUGH, and that is the whole point: the shim exists. A candidate is only
 * usable if it actually RUNS, so the caller injects `works()` and the ordering is decided here.
 * Same split as `bashResolve.ts` — the choice is pure so it can be tested off the platform it
 * matters on; `src/main/aios.ts` does the looking.
 */
export interface GitProbe {
  platform: string;
  /** First hit from `which git` / `where git`, if the launching environment had one. */
  pathHit?: string;
  /** Does this candidate exist AND run? The Xcode shim exists and does not run. */
  works(p: string): boolean;
}

/** Real installs, before the macOS shim that may not be licensed. */
export function gitCandidates(platform: string, pathHit?: string): string[] {
  const mac = ['/opt/homebrew/bin/git', '/usr/local/bin/git'];
  const nix = ['/usr/local/bin/git', '/usr/bin/git', '/bin/git'];
  const out: string[] = [];
  if (platform === 'darwin') out.push(...mac);
  else if (platform !== 'win32') out.push(...nix);
  if (pathHit) out.push(pathHit);
  /* The shim LAST on macOS: when Xcode's licence has been accepted it is a perfectly good git,
     and a machine with no Homebrew has nothing else. Last, never first. */
  if (platform === 'darwin') out.push('/usr/bin/git');
  return [...new Set(out)];
}

/**
 * The git to run, or `'git'` as the last resort — never empty, because a caller that gets an
 * empty string would spawn nothing and report that as "git is missing", which is a different
 * and wrong diagnosis.
 */
export function pickGit(probe: GitProbe): string {
  for (const c of gitCandidates(probe.platform, probe.pathHit)) {
    if (probe.works(c)) return c;
  }
  return 'git';
}
