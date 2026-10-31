import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { pickBash, gitBashCandidates } from '../core/bashResolve';

/**
 * Where is a `bash` this process can actually run? (AI-146 · canonical issue #116)
 *
 * MEASURED ON WINDOWS: a bus request carrying `"tier":"judgment"` was claimed and retired as
 * `spawnSync bash ENOENT`, while the identical request WITHOUT the field was fulfilled 90s later.
 * So the field was the defect, not the bus — and `hooks/resolve-tier` itself is fine: from Git
 * Bash on that same machine it returns Haiku for `fast` and empty+exit-0 for `judgment`, exactly
 * as documented.
 *
 * THE GAP IS NOT A MISSING `.ps1`, and that distinction is the whole fix. Six extensionless bash
 * hooks ship with no PowerShell sibling — `aios-commit`, `aios-snapshot`, `aios-note-append`,
 * `pre-commit`, `pre-push`, `resolve-tier` — and a Windows operator runs `aios-commit` daily.
 * They work because a SESSION has bash. `resolve-tier` is simply the only one whose caller is a
 * Node process, and Node inherits no shell. So locating a bash HONOURS a prerequisite that
 * already exists rather than adding one; shipping a third hand-maintained copy of the rung→model
 * table would be the change that adds something, and it is the drift AI-129 ended.
 *
 * Ordered, and each step says what it proves. Returns null when nothing is found, which is a
 * REFUSAL — never a licence to default a model.
 */
export function resolveBash(): string | null {
  /* THE LOOKING lives here; the CHOOSING lives in src/core/bashResolve.ts, so the ordering can be
     exercised from any platform. `where bash` is Windows' own PATH lookup and prints one hit per
     line; everything else is read from the environment. */
  let pathHit: string | undefined;
  if (process.platform === 'win32') {
    try {
      pathHit = execFileSync('where', ['bash'], { encoding: 'utf8', timeout: 5_000, windowsHide: true })
        .split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
    } catch { /* not on PATH — pickBash falls through to the Git for Windows locations */ }
  }
  return pickBash(process.platform, {
    shell: process.env.SHELL,
    pathHit,
    programFiles: process.env.ProgramFiles,
    localAppData: process.env.LOCALAPPDATA,
    exists: (f) => { try { return fs.existsSync(f); } catch { return false; } },
  });
}
