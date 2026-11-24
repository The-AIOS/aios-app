/**
 * The updater's trace on disk, and what happens when the App quits with an update waiting (#201).
 *
 * WHY A FILE. electron-updater logged only to the console. On Windows the install that runs when
 * the App quits happens after the window is gone, so a console line goes nowhere a person can
 * read — and when that install was interrupted, the machine was left with no App and no evidence
 * of what happened. The operator could not tell us, because nothing told them. A plain file under
 * the App's data folder (`%APPDATA%\AIOS\updater.log`, `~/Library/Application Support/AIOS/…`)
 * survives the uninstaller, which never touches that folder, so a failed install leaves a trace.
 *
 * WHY RELAUNCH ON WINDOWS. The electron-builder one-click NSIS upgrade runs the OLD uninstaller
 * first and writes the new version after; for several seconds the App does not exist on disk.
 * The library's own quit-time install passes `/S` and no `--force-run`, so the App never comes
 * back by itself — nothing tells the operator an install is running, and shutting the laptop
 * right after closing the App is exactly what interrupts it. With `--force-run` the installer
 * starts the App when it is done, so the window ends with the App open and visible.
 * Only Windows: macOS installs through Squirrel.Mac (a different code path, never uninstalled
 * mid-update) and Linux is left exactly as it was.
 *
 * Pure, so the tests drive it directly; `src/main/updater.ts` only reads the inputs and acts.
 */

/** Past this size the log is rotated to `updater.log.1` (one generation kept). */
export const UPDATER_LOG_MAX_BYTES = 512 * 1024;

/** One line of the log: ISO time, level, message on one line (a stack never spans the file). */
export function formatUpdaterLine(level: 'info' | 'warn' | 'error', message: unknown, now: Date): string {
  const text = String(message ?? '').replace(/\r?\n/g, ' ⏎ ').trim();
  return `${now.toISOString()} ${level.padEnd(5)} ${text}\n`;
}

/** Rotate before appending? Only when the file already reached the cap. */
export function shouldRotateUpdaterLog(currentSize: number, max = UPDATER_LOG_MAX_BYTES): boolean {
  return Number.isFinite(currentSize) && currentSize >= max;
}

export interface QuitInstallInputs {
  /** process.platform */
  platform: string;
  /** An update has finished downloading and is staged. */
  downloaded: boolean;
  /** An install was already started (the pill, or unattended mode) — never start a second one. */
  alreadyTriggered: boolean;
  /** The exit code the App is quitting with. A crash or forced exit must not install. */
  exitCode: number;
}

/**
 * On quit: install the staged update, and how. `null` = do nothing.
 * Mirrors electron-updater's own quit handler (silent, skipped on a non-zero exit or when an
 * install was already triggered) and differs in one thing only: run the App after (`--force-run`).
 */
export function quitInstallPlan(i: QuitInstallInputs): { silent: true; runAfter: true } | null {
  if (i.platform !== 'win32') return null;   // not ours: the library's handler stays in charge
  if (!i.downloaded || i.alreadyTriggered) return null;
  if (i.exitCode !== 0) return null;
  return { silent: true, runAfter: true };
}

/** Does this platform use our quit handler instead of the library's `autoInstallOnAppQuit`? */
export function ownsQuitInstall(platform: string): boolean {
  return platform === 'win32';
}
