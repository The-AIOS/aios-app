/**
 * Which `bash` should a NODE process use? — the decision, with no filesystem in it (AI-146).
 *
 * WHY THIS IS PURE. The bug it exists for is Windows-only, and the machine that fixes it is
 * usually not Windows: `resolve-tier` is a bash hook, the App's Node process has no shell, and a
 * request carrying `"tier"` died as `spawnSync bash ENOENT` while the same request without the
 * field was fulfilled. The spec that decided this fix says the quiet part out loud — *"a green
 * CI on Linux is not evidence here"* — so the ordering has to be exercisable from any platform,
 * or it ships tested only on the one platform where it does nothing.
 *
 * So the CHOICE lives here, taking what it needs as data: the platform, the environment, whether
 * a path exists, and whatever `where bash` found. `src/main/commandBus.ts` does the looking. Same
 * arrangement as `fitsAnother(count, zoneWidth)` in src/core/split.ts, which takes a MEASURED
 * width rather than assuming one — and for the same reason: a decision that reads the world
 * itself can only be tested in the world it happens to be running in.
 */
export interface BashProbe {
  /** `$SHELL`, when the app was launched from a shell that has one. */
  shell?: string;
  /** The first hit from Windows' own `where bash`, if any. */
  pathHit?: string;
  programFiles?: string;
  localAppData?: string;
  /** Does this path exist? Injected so the ordering is testable off-Windows. */
  exists(p: string): boolean;
}

/** Where Git for Windows actually installs bash, in the order worth trying. */
export function gitBashCandidates(programFiles?: string, localAppData?: string): string[] {
  const pf = programFiles || 'C:\\Program Files';
  const out = [`${pf}\\Git\\bin\\bash.exe`, `${pf}\\Git\\usr\\bin\\bash.exe`];
  if (localAppData) out.push(`${localAppData}\\Programs\\Git\\bin\\bash.exe`);
  return out;
}

/**
 * The ordered answer. `null` means REFUSE — never a licence to fall back to a model or another
 * interpreter, because a loud dead letter beats a silent wrong model.
 *
 * Step 1 is the load-bearing one for everybody who is not on Windows: the bare word, unchanged,
 * so macOS and Linux keep the exact behaviour they had before this function existed.
 */
export function pickBash(platform: string, p: BashProbe): string | null {
  if (platform !== 'win32') return 'bash';
  /* Launched FROM a bash (Git Bash / MSYS): $SHELL names it. */
  if (p.shell && /bash/i.test(p.shell) && p.exists(p.shell)) return p.shell;
  /* On PATH, per Windows' own lookup. */
  if (p.pathHit && p.exists(p.pathHit)) return p.pathHit;
  /* Where Git for Windows puts it. */
  for (const c of gitBashCandidates(p.programFiles, p.localAppData)) if (p.exists(c)) return c;
  return null;
}
