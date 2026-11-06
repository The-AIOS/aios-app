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
import { menuBarModel, menuBarTitle, sameModel, dotBitmap, STATE_DOT_COLOR, type MenuBarModel, type MenuBarSession, type SessionState } from '../core/menuBar';

export interface MenuBarHooks {
  /** Bring the App forward on one session — the same path a "needs you" banner click takes. */
  reveal(target: { name: string; sessionId?: string }): void;
  openApp(): void;
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
const dots = new Map<SessionState, Electron.NativeImage>();
function stateDot(state: SessionState): Electron.NativeImage {
  let img = dots.get(state);
  if (img) return img;
  const hex = STATE_DOT_COLOR[state];
  img = nativeImage.createFromBitmap(Buffer.from(dotBitmap(hex, DOT_PT)), { width: DOT_PT, height: DOT_PT, scaleFactor: 1 });
  img.addRepresentation({ scaleFactor: 2, width: DOT_PT * 2, height: DOT_PT * 2, buffer: Buffer.from(dotBitmap(hex, DOT_PT * 2)) });
  dots.set(state, img);
  return img;
}

/** Where the template image lives in the packaged app: `renderer/` is packaged, `build/` is not. */
export function iconPath(appRoot: string): string {
  return path.join(appRoot, 'renderer', 'tray', 'iconTemplate.png');
}

export class MenuBar {
  private tray?: Tray;
  private model?: MenuBarModel;

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
    if (!this.active) return;
    const next = menuBarModel(sessions);
    if (sameModel(this.model, next)) return;
    this.render(next);
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
    const rows: Electron.MenuItemConstructorOptions[] = model.rows.length
      ? model.rows.map((r) => ({
        label: r.name,
        icon: stateDot(r.state),          // the sidebar's colour for this state, instead of "— ready" (0.15.0 round)
        toolTip: t(STATE_KEY[r.state]),   // the state still in words, on hover
        click: () => this.hooks.reveal({ name: r.name, sessionId: r.id || undefined }),
      }))
      : [{ label: t('menuBar.empty'), enabled: false }];
    return [
      { label: t('menuBar.sessions'), enabled: false },
      ...rows,
      { type: 'separator' },
      { label: t('menuBar.open'), click: () => this.hooks.openApp() },
      { label: t('menu.settings'), click: () => this.hooks.openSettings() },
      { type: 'separator' },
      { label: t('menu.quit'), click: () => this.hooks.quit() },
    ];
  }
}
