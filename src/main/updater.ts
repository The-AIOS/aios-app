import { app, ipcMain, BrowserWindow, powerMonitor } from 'electron';
import { autoUpdater } from 'electron-updater';

/**
 * Auto-update — the last mile for app-only operators (no terminal, cannot
 * rebuild from source). Modelled on Block's Buzz (github.com/block/buzz), the
 * closest precedent, adapted to the electron-updater idiom rather than Tauri's:
 *
 *   - Distribution channel = GitHub Releases (NOT the Mac App Store — the app
 *     spawns real `claude` PTYs / reads ~/aios / runs installers, which the MAS
 *     sandbox forbids). See the `publish` block in package.json.
 *   - electron-builder writes `latest-mac.yml` + the .dmg (+ .blockmap) to each
 *     versioned release; electron-updater polls the newest release, reads that
 *     manifest, and downloads deltas. No update server, ever.
 *   - THE TWO GUARANTEES, kept distinct (Buzz's load-bearing mental model):
 *       1. Apple Developer-ID codesign + notarize  → Gatekeeper admits the app.
 *       2. update integrity                          → on macOS electron-updater
 *          verifies each downloaded update *via the code signature itself*, so
 *          no second (minisign) key is needed — but the signature it rides on
 *          MUST be real. That is why this never runs unsigned/in dev.
 *
 * The RENDERER surface (a "restart to update" card) is deliberately NOT built
 * here — it folds into the Needs-you inbox card (batch G) during the walk.
 * This module owns only the mechanism: check → download → native notify →
 * install-on-quit, plus event forwarding on `shell:updater` for that future
 * card, and two IPC handles a UI can call when it lands.
 */

const SIX_HOURS = 6 * 60 * 60 * 1000;
/** Last check time, shared by the menu handler and the event triggers so they cannot double-poll. */
const lastCheckRef = { at: 0 };

export function initAutoUpdater(getWin: () => BrowserWindow | undefined): void {
  /* The single renderer sender. Kept above the isPackaged return so any future dev-side emit
     can use it without reintroducing a TDZ: a `const` referenced above its own declaration
     throws at module load and `node --check` cannot see it — this repo has already lost a
     build to exactly that. */
  const send = (channel: string, payload?: unknown): void => {
    const win = getWin();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('shell:updater', { channel, payload });
    }
  };
  /* REGISTERED BEFORE THE isPackaged GATE. This handler used to live below it, so in a dev build
     it did not exist at all — the renderer's invoke rejected and the UI reported "check your
     connection", blaming the network for a feature that structurally cannot run unpackaged.
     A button must never explain a failure it does not understand. */
  ipcMain.handle('updater:checkNow', async () => {
    if (!app.isPackaged) return { ok: false, dev: true, current: app.getVersion() };
    lastCheckRef.at = Date.now();
    try {
      const r = await autoUpdater.checkForUpdatesAndNotify();
      const v = r && r.updateInfo ? r.updateInfo.version : '';
      return { ok: true, version: v || '', current: app.getVersion() };
    } catch (e) { return { ok: false, message: String((e as Error)?.message ?? e), current: app.getVersion() }; }
  });

  // Never in dev / smoke / CI: an unpackaged app has no `app-update.yml`
  // (electron-builder bundles it from the `publish` block), and firing the
  // updater without a real code signature is exactly the mistake the Buzz
  // teardown warns against. isPackaged is the single honest gate.
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;          // fetch in the background…
  autoUpdater.autoInstallOnAppQuit = true;  // …install on the next quit (no forced restart)

  const emit = send;

  /* electron-updater logs to the console by default, and until this repo publishes releases
     the feed 404s — so every launch dumped a full HttpError with headers and a stack into the
     log. It was already handled (see the 'error' listener and the catch below); the problem
     was that it READ like a failure to anyone reading a newcomer's log. A 404 on the release
     feed is the expected state before the first release, so it is reported as one line and
     everything else is passed through untouched. */
  autoUpdater.logger = {
    info: (m: unknown) => console.log('[updater]', String(m)),
    warn: (m: unknown) => console.log('[updater]', String(m)),
    debug: () => { /* too chatty for a shipped log */ },
    error: (m: unknown) => {
      const msg = String(m);
      if (/404/.test(msg) && /releases/.test(msg)) {
        console.log('[updater] no published releases yet — nothing to update to (expected)');
        return;
      }
      console.log('[updater] error:', msg.split('\n')[0]);
    },
  } as never;
  autoUpdater.on('checking-for-update', () => emit('checking'));
  autoUpdater.on('update-available', (info) => emit('available', { version: info.version }));
  autoUpdater.on('update-not-available', () => emit('none'));
  autoUpdater.on('download-progress', (p) => emit('progress', { percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => emit('ready', { version: info.version }));
  autoUpdater.on('error', (err) => emit('error', { message: String(err?.message ?? err) }));

  // Manual "check now" + "restart & install" for a future UI button. Both are
  // safe no-ops today (no renderer wires them yet) — scaffolding, not surface.
  ipcMain.handle('updater:check', () => autoUpdater.checkForUpdatesAndNotify());
  ipcMain.handle('updater:quitAndInstall', () => { autoUpdater.quitAndInstall(); });

  // Check on boot, then every 6h while the app stays open. `checkForUpdatesAndNotify`
  // auto-downloads and raises a NATIVE OS notification when an update is staged —
  // the zero-friction path for a non-technical operator, no in-app UI required.
  /* CHECK ON REAL EVENTS, not only on elapsed time.
     Measured 2026-07-31: an install had been running 2.6 days on one process and a release
     published at 15:00 had produced no download by 17:51. The interval is not the mechanism — a
     `setInterval` runs on the process's own clock, which does not track wall time across sleep,
     and macOS App Nap coalesces timers in an idle backgrounded app. Neither the operator nor the
     developer can say WHEN it will fire, and an update whose arrival nobody can predict is one
     nobody waits for. Shortening the interval would not fix that; it would just poll harder.
     So: boot (already worked) · window focus · system wake · an explicit menu item. Each is a
     real event the OS delivers, and each answers a different question — "is there one?" versus
     "tell me when I come back". The interval stays as a backstop, no longer as the plan. */
  const lastCheck = lastCheckRef;   // shared with the menu handler registered above
  const MIN_GAP = 15 * 60 * 1000;   // never hammer the feed on rapid focus changes
  const check = (why: string, force = false): void => {
    const now = Date.now();
    if (!force && now - lastCheck.at < MIN_GAP) return;
    lastCheck.at = now;
    console.log(`[updater] checking (${why})`);
    void autoUpdater.checkForUpdatesAndNotify().catch(() => { /* offline / no release yet — silent */ });
  };
  check('boot', true);
  const timer = setInterval(() => check('interval'), SIX_HOURS);

  // Focus: the moment the operator comes back to the app is exactly when a pending update is
  // worth raising, and it is the event an interval cannot approximate.
  app.on('browser-window-focus', () => check('focus'));

  /* Wake: the event that was actually missed in the measurement above. A machine that slept two
     nights is precisely the case where the timer's clock and the wall clock disagree most. */
  try { powerMonitor.on('resume', () => check('system wake', true)); } catch { /* not available */ }


  app.on('before-quit', () => clearInterval(timer));
}
