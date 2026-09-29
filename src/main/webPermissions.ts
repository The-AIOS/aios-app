/**
 * WHAT WEB CONTENT MAY ASK FOR — decided here, not by Electron's default, which is to GRANT.
 *
 * The App never set a permission handler, so every permission a page requested was allowed. That
 * was invisible while the App could not reach the microphone at all. v0.10.1 grants the macOS
 * audio-input entitlement (app#40) so Claude Code's voice mode works in a pane, and from then on
 * a page in an App browser pane (#14: the Manual, any URL the operator opens) could record once
 * the operator had allowed AIOS the microphone for voice mode, with no further prompt.
 *
 * Voice mode does not go through here: `claude` is a native process in a PTY, and macOS decides
 * its access by the App's entitlement and the TCC prompt. This only governs WEB content.
 *
 * Denied: capture devices and the screen, location, and raw device access (none of which the
 * App's own interface uses; its clipboard goes through the main process). Everything else keeps
 * Electron's behaviour, so nothing the interface relies on changes.
 */
import type { Session } from 'electron';

export const DENIED_WEB_PERMISSIONS = new Set<string>([
  'media',            // microphone + camera (getUserMedia)
  'display-capture',  // screen recording (getDisplayMedia)
  'geolocation',
  'midi', 'midiSysex',
  'hid', 'serial', 'usb',
  'idle-detection',
]);

export function webPermissionAllowed(permission: string): boolean {
  return !DENIED_WEB_PERMISSIONS.has(permission);
}

/** Install on a session: both the request (prompted) and the check (synchronous) paths. */
export function installWebPermissionPolicy(s: Session): void {
  s.setPermissionRequestHandler((_wc, permission, cb) => cb(webPermissionAllowed(permission)));
  s.setPermissionCheckHandler((_wc, permission) => webPermissionAllowed(permission));
}
