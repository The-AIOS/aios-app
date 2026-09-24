/**
 * Is the App quitting for real, or did someone just close the window?
 *
 * On macOS the red button hides the window instead of quitting (see main.ts). The App is more
 * than a window: its terminals run in it and it answers the spawn-inbox, so quitting on a
 * reflexive close cut live sessions and left agents' requests unclaimed (operator-reported
 * 2026-09-23). A real quit must still get through, and it arrives two ways:
 *   · ⌘Q, the Dock's Quit, logout, shutdown: `before-quit` fires first, then the windows close.
 *   · Installing an update (`quitAndInstall`): the windows close FIRST, and `before-quit` only
 *     comes after. Anything that waits for `before-quit` would hide the window and block the
 *     install, so the updater marks the quit itself before it calls quitAndInstall.
 */
let quitting = false;
export function markQuitting(): void { quitting = true; }
export function isQuitting(): boolean { return quitting; }

/** The whole close decision, kept pure so it can be tested without a window. */
export function closeShouldHide(platform: NodeJS.Platform, quittingNow: boolean, testRun: boolean): boolean {
  return platform === 'darwin' && !quittingNow && !testRun;
}
