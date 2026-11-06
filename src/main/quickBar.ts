/**
 * THE QUICK BAR — one line of text from any app, to a new session, an agent or a live session
 * (RFC: docs/rfcs/menu-bar.md § 2.2, § 3.2–3.4).
 *
 * A small frameless panel on a global shortcut. It writes an ordinary spawn-inbox request addressed to
 * this surface (core/quickBar) and hides; the bus does the rest, exactly as it would for an agent. The
 * window has its own narrow preload — destinations, submit, close — and no PTY, file or settings access.
 */
import { BrowserWindow, globalShortcut, ipcMain, screen } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { t } from '../i18n';
import { quickBarRequest, type QuickBarDestination } from '../core/quickBar';
import { askSessionName, uniqueName } from '../core/sessionName';
import { isBlockedStatus } from '../core/attention';

export interface QuickBarDeps {
  appRoot: string;
  inboxDir(): string;
  /** Live operator sessions, as the panel lists them. */
  sessions(): Array<{ name: string; sessionId: string; status: string }>;
  /** Every registered name (any kind) — a new session must never take one. */
  takenNames(): string[];
  agents(): Array<{ name: string; description?: string; group?: string }>;
  primaryNames(): string[];
  theme(): 'dark' | 'light';
  /** ⌘Enter: bring the main window forward, on this session when it already exists. */
  reveal(target: { name: string }): void;
  log(msg: string): void;
}

const WIDTH = 680;
const HEIGHT = 560;   // the panel is transparent around the bar; the list grows into this space

export class QuickBar {
  private win?: BrowserWindow;
  private registered = '';

  constructor(private readonly deps: QuickBarDeps) {
    ipcMain.handle('quickBar:destinations', () => this.destinations());
    ipcMain.handle('quickBar:suggestName', (_e, text: unknown) => this.suggestName(String(text ?? '')));
    ipcMain.handle('quickBar:submit', (_e, dest: QuickBarDestination, text: unknown, reveal: unknown) => this.submit(dest, String(text ?? ''), reveal === true));
    ipcMain.on('quickBar:close', () => this.hide());
  }

  /** The accelerator currently held, or '' when none is (not configured, or another app owns it). */
  get shortcut(): string { return this.registered; }

  /**
   * Take `accel` as the global shortcut, releasing any previous one. Returns whether the OS granted it:
   * `false` means another app owns the combination, and the caller says so instead of failing silently.
   */
  setShortcut(accel: string): boolean {
    if (this.registered) { try { globalShortcut.unregister(this.registered); } catch { /* already gone */ } }
    this.registered = '';
    const a = accel.trim();
    if (!a) return true;   // empty = no global shortcut, by choice
    let ok = false;
    try { ok = globalShortcut.register(a, () => this.toggle()); } catch { ok = false; }
    if (ok) { this.registered = a; this.deps.log(`quick bar: ${a} registered`); }
    else this.deps.log(`quick bar: ${a} could not be registered — another app holds it`);
    return ok;
  }

  dispose(): void {
    if (this.registered) { try { globalShortcut.unregister(this.registered); } catch { /* gone */ } }
    this.registered = '';
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = undefined;
  }

  toggle(): void {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) { this.hide(); return; }
    this.show();
  }

  show(): void {
    const win = this.ensureWindow();
    /* On the display under the pointer, a quarter of the way down — where the eye already is. */
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    win.setBounds({ x: Math.round(d.x + (d.width - WIDTH) / 2), y: Math.round(d.y + d.height * 0.22), width: WIDTH, height: HEIGHT });
    /* The first open races the page load: a message sent before the page listens is lost, and the bar
       would show with no strings and no destination. */
    const announce = (): void => { if (!win.isDestroyed()) win.webContents.send('quickBar:open', { theme: this.deps.theme() }); };
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', announce);
    else announce();
    win.show();
    win.focus();
  }

  hide(): void {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.win.hide();
  }

  private ensureWindow(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const win = new BrowserWindow({
      width: WIDTH, height: HEIGHT, show: false, frame: false, transparent: true, resizable: false,
      movable: true, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true,
      hasShadow: false, alwaysOnTop: true,
      ...(process.platform === 'darwin' ? { type: 'panel' as const } : {}),
      title: 'AIOS',
      webPreferences: {
        preload: path.join(this.deps.appRoot, 'out', 'preload', 'quickBarPreload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.setAlwaysOnTop(true, 'floating');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    /* Click elsewhere and it goes away — the bar is a moment, not a window to manage. */
    win.on('blur', () => this.hide());
    win.on('closed', () => { this.win = undefined; });
    void win.loadFile(path.join(this.deps.appRoot, 'renderer', 'quickbar.html'));
    this.win = win;
    return win;
  }

  private destinations(): Record<string, unknown> {
    return {
      strings: {
        placeholder: t('quickBar.placeholder'),
        newSession: t('quickBar.newSession'),
        agents: t('quickBar.agents'),
        sessions: t('quickBar.sessions'),
        filter: t('quickBar.filter'),
        hint: t('quickBar.hint'),
        nameLabel: t('quickBar.nameLabel'),
        emptyText: t('quickBar.emptyText'),
        failed: t('quickBar.failed'),
      },
      agents: this.deps.agents().map((a) => ({ name: a.name, desc: a.description ?? '' })),
      /* Only the state that changes what you would type: a session waiting on you is marked, the rest are just names. */
      sessions: this.deps.sessions().map((s) => ({ name: s.name, waiting: isBlockedStatus(s.status) })),
      waitingLabel: t('status.needsInput'),
    };
  }

  private suggestName(text: string): string {
    return askSessionName(text, { identities: this.deps.primaryNames(), live: this.deps.takenNames() });
  }

  /** Write the request and hide. Returns the outcome so the bar can stay open and say why when it failed. */
  private submit(dest: QuickBarDestination, text: string, reveal: boolean): { ok: boolean; reason?: string } {
    if (!dest || !['new', 'agent', 'session'].includes(dest.kind)) return { ok: false, reason: 'name' };
    /* A new session never takes a name that is running — the bar's suggestion was unique when it was made,
       not necessarily now, and the operator may have typed over it. */
    const target: QuickBarDestination = dest.kind === 'new'
      ? { kind: 'new', name: uniqueName(String(dest.name ?? ''), this.deps.takenNames()) }
      : dest.kind === 'agent'
        /* Same for an agent: a second "lawyer" while one is running would be revealed, not started, and the
           text lost. It runs as "lawyer-2" instead, exactly as a new session would. */
        ? { kind: 'agent', name: String(dest.name ?? ''), session: uniqueName(String(dest.name ?? ''), this.deps.takenNames()) }
        : dest;
    const req = quickBarRequest(target, text, Date.now());
    if (!req.ok) return { ok: false, reason: req.reason };
    try {
      const dir = this.deps.inboxDir();
      fs.mkdirSync(dir, { recursive: true });
      /* Whole or not at all: the bus watches this directory, and must never read half a request. */
      const tmp = path.join(dir, `.${req.file}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(req.body, null, 2));
      fs.renameSync(tmp, path.join(dir, req.file));
    } catch (e) {
      this.deps.log(`quick bar: could not write the request — ${(e as Error).message}`);
      return { ok: false, reason: 'write' };
    }
    this.deps.log(`quick bar: ${target.kind} → '${req.body.name}'`);
    this.hide();
    if (reveal) this.deps.reveal({ name: req.body.name });
    return { ok: true };
  }
}
