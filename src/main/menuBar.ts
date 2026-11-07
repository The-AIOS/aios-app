/**
 * THE MENU-BAR ICON (macOS) — the operator's live sessions at a glance, from any app
 * (RFC: docs/rfcs/menu-bar.md § 2.1, § 3.1).
 *
 * Glass, not engine: it renders the list `PanelHost.postRunning()` already computes every 2 s for
 * the panel and the Dock badge, through the pure model in `core/menuBar`. It owns no timer and
 * reads no file of its own.
 *
 * The title and tooltip follow the model; the menu itself is built when the icon is clicked
 * (`popUpContextMenu`), so a state change never swaps a menu the operator has open.
 */
import { Menu, Tray, nativeImage } from 'electron';
import * as path from 'path';
import { t } from '../i18n';
import { menuBarModel, menuBarTitle, sameModel, dotBitmap, STATE_DOT_COLOR, groupDotColor, type MenuBarModel, type MenuBarSession, type MenuBarGroup, type SessionState } from '../core/menuBar';

export interface MenuBarHooks {
  /** Bring the App forward on one session — the same path a "needs you" banner click takes. */
  reveal(target: { name: string; sessionId?: string }): void;
  openApp(): void;
  /** Ask AIOS from here: the floating Ask when it exists, else the App's own Ask panel. */
  ask(): void;
  openSettings(): void;
  quit(): void;
}

const STATE_KEY: Record<SessionState, string> = {
  busy: 'status.working',
  input: 'status.needsInput',
  error: 'menuBar.stateError',
  idle: 'status.ready',
};

/** One coloured dot per state, built once at 1x and 2x (12 pt). NOT a template image: macOS would recolour it. */
const DOT_PT = 12;
const dots = new Map<string, Electron.NativeImage>();
function stateDot(state: SessionState): Electron.NativeImage { return colourDot(STATE_DOT_COLOR[state]); }
/** A group heading's dot, in the group's own colour. */
function groupDot(colour: string): Electron.NativeImage { return colourDot(groupDotColor(colour)); }
function colourDot(hex: string): Electron.NativeImage {
  let img = dots.get(hex);
  if (img) return img;
  img = nativeImage.createFromBitmap(Buffer.from(dotBitmap(hex, DOT_PT)), { width: DOT_PT, height: DOT_PT, scaleFactor: 1 });
  img.addRepresentation({ scaleFactor: 2, width: DOT_PT * 2, height: DOT_PT * 2, buffer: Buffer.from(dotBitmap(hex, DOT_PT * 2)) });
  dots.set(hex, img);
  return img;
}

/** Where the template image lives in the packaged app: `renderer/` is packaged, `build/` is not. */
export function iconPath(appRoot: string): string {
  return path.join(appRoot, 'renderer', 'tray', 'iconTemplate.png');
}

/** macOS 14 (Sonoma, Darwin 23) added native menu section headers; Electron's `type: 'header'` maps to them. */
function sectionHeadersSupported(): boolean {
  if (process.platform !== 'darwin') return false;
  const major = Number(String(process.getSystemVersion?.() || '0').split('.')[0]);
  return major >= 14;
}

export class MenuBar {
  private tray?: Tray;
  private model?: MenuBarModel;
  private sessions: readonly MenuBarSession[] = [];
  private groups: MenuBarGroup[] = [];

  constructor(private readonly hooks: MenuBarHooks, private readonly appRoot: string) {}

  get active(): boolean { return !!this.tray && !this.tray.isDestroyed(); }

  /** Create the icon (idempotent). Returns false when the platform refused it. */
  enable(): boolean {
    if (this.active) return true;
    try {
      /* `iconTemplate.png` + its `@2x` sibling: nativeImage picks the right one per display, and the
         `Template` suffix lets macOS tint it for a light or dark menu bar. */
      const img = nativeImage.createFromPath(iconPath(this.appRoot));
      img.setTemplateImage(true);
      this.tray = new Tray(img);
    } catch {
      this.tray = undefined;
      return false;
    }
    this.tray.setToolTip('AIOS');
    /* The menu is built when it opens, never swapped while it is open (0.15.0 review): with many sessions a state changes
       every few seconds, and a setContextMenu at each change closed the menu under the operator's pointer. */
    const open = (): void => { const tr = this.tray; if (tr && !tr.isDestroyed()) tr.popUpContextMenu(Menu.buildFromTemplate(this.template(this.model ?? menuBarModel([])))); };
    this.tray.on('click', open);
    this.tray.on('right-click', open);
    this.model = undefined;
    this.render(menuBarModel([]));
    return true;
  }

  disable(): void {
    if (this.tray && !this.tray.isDestroyed()) this.tray.destroy();
    this.tray = undefined;
    this.model = undefined;
  }

  /** One observation from the 2 s pulse. Cheap when nothing changed. */
  update(sessions: readonly MenuBarSession[]): void {
    this.sessions = sessions;
    if (!this.active) return;
    const next = menuBarModel(sessions, this.groups);
    if (sameModel(this.model, next)) return;
    this.render(next);
  }

  /** The App's tab groups, as the renderer last reported them (0.15.0 round 2). The next open shows them. */
  setGroups(groups: MenuBarGroup[]): void {
    this.groups = groups;
    if (!this.active) return;
    this.render(menuBarModel(this.sessions, groups));
  }

  /** Re-render with the current model — after a locale change, when the strings moved but the sessions did not. */
  relabel(): void {
    if (!this.active) return;
    const m = this.model ?? menuBarModel([]);
    this.model = undefined;
    this.render(m);
  }

  private render(model: MenuBarModel): void {
    const tray = this.tray;
    if (!tray || tray.isDestroyed()) return;
    this.model = model;
    tray.setTitle(menuBarTitle(model));
    tray.setToolTip(model.waiting > 0 ? t('menuBar.tooltipWaiting', { n: model.waiting }) : 'AIOS');
  }

  private template(model: MenuBarModel): Electron.MenuItemConstructorOptions[] {
    /* Round 3 (operator): Ask and Show at the top, then the sessions, then Settings and Quit. A group's name is a native
       section header on macOS 14+ (the system's own look, aligned with nothing to fake); before 14, a disabled row with the
       group's colour dot. Members carry only their state dot: leading spaces moved the text but never the icon, so the dots
       looked misaligned. */
    const headers = sectionHeadersSupported();
    const rows: Electron.MenuItemConstructorOptions[] = [];
    let last = -2;
    for (const r of model.rows) {
      if (r.group !== last) {
        if (r.group >= 0) {
          const g = model.groups[r.group];
          const label = g.name || t('tg.unnamed', { color: t('tg.color.' + g.color) });
          if (rows.length) rows.push({ type: 'separator' });
          rows.push(headers ? { type: 'header', label, icon: groupDot(g.color) } : { label, icon: groupDot(g.color), enabled: false });
        } else if (last >= 0) rows.push({ type: 'separator' });
        last = r.group;
      }
      rows.push({
        label: r.name,
        icon: stateDot(r.state),          // the sidebar's colour for this state, instead of "— ready" (0.15.0 round)
        toolTip: t(STATE_KEY[r.state]),   // the state still in words, on hover
        click: () => this.hooks.reveal({ name: r.name, sessionId: r.id || undefined }),
      });
    }
    if (!rows.length) rows.push({ label: t('menuBar.empty'), enabled: false });
    else if (!model.groups.length) rows.unshift(headers ? { type: 'header', label: t('menuBar.sessions') } : { label: t('menuBar.sessions'), enabled: false });
    return [
      { label: t('menuBar.ask'), click: () => this.hooks.ask() },
      { label: t('menuBar.open'), click: () => this.hooks.openApp() },
      { type: 'separator' },
      ...rows,
      { type: 'separator' },
      { label: t('menu.settings'), click: () => this.hooks.openSettings() },
      { label: t('menu.quit'), click: () => this.hooks.quit() },
    ];
  }
}
