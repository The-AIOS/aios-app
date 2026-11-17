/**
 * The "update ready" system notification, once per version (#183).
 *
 * The App used `checkForUpdatesAndNotify()`, which raises the system notification every time a
 * check finds the staged update. The App checks on boot, on window focus, on system wake, from the
 * menu and every six hours, and once an update has downloaded, every one of those checks notified
 * again. Switching windows was enough to bring it back.
 *
 * Now the App checks with `checkForUpdates()` and raises the notification itself, through this
 * rule: once per version, remembered across restarts. The update pill in the window stays the
 * quiet, permanent signal. Pure, so a test can drive every case.
 */

/** Raise the notification for `version`? Only for a real version not already announced. */
export function shouldNotifyUpdate(version: string, lastNotified: string): boolean {
  const v = String(version || '').trim();
  return v !== '' && v !== String(lastNotified || '').trim();
}

/** The remembered version, read from the file's text. Anything unreadable means "none yet". */
export function parseNotified(text: string | null): string {
  if (!text) return '';
  try {
    const v = (JSON.parse(text) as { version?: unknown }).version;
    return typeof v === 'string' ? v : '';
  } catch { return ''; }
}
