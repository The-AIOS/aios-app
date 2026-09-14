/**
 * Electron glue for the two attention counters (#22): the Dock badge and the macOS banner.
 *
 * All of the *deciding* lives in `../core/attention` — when a block is new, when a result
 * counts as unread, what the badge should read. This file only does the things that need a
 * display: setting a badge, raising a notification, and bringing the right pane forward.
 *
 * ON FOCUS MODES. The issue asks that Focus be respected, and the correct implementation is to
 * do nothing: a plain `new Notification()` goes through the OS notification centre, which
 * already withholds banners under Focus / Do Not Disturb and delivers them afterwards. Anything
 * we added to "check Focus ourselves" would be a second, worse copy of a decision the OS has
 * already made — and every mechanism for bypassing it is one the operator did not ask for.
 *
 * ON NOT DUPLICATING THE PHONE — measured against Claude Code 2.1.270, not assumed. Its
 * Mac-side notification channels are all TERMINAL ESCAPES (iTerm2 OSC 9, bell, Kitty OSC 99,
 * Ghostty OSC 777) and this app's xterm build subscribes to none of them; its only `osascript`
 * banner is for re-authentication. So a session blocked inside the App raises no native banner
 * today, and this is the first one rather than a second. `inputNeededNotifEnabled` /
 * `agentPushNotifEnabled` push to the PHONE over Remote Control and are untouched here.
 */
import { app, Notification } from 'electron';
import {
  attentionTick, markNotified, badgeText, mayBanner,
  EMPTY_ATTENTION, type AttentionState, type NotifyLevel,
} from '../core/attention';
import type { RunningAgent } from './aios';
import { t } from '../i18n';

export interface AttentionHooks {
  /** true when the App has system focus and is not minimized. */
  appVisible(): boolean;
  /** Bring the App forward and focus the pane running `pid`. */
  reveal(pid: number): void;
}

export class Attention {
  private state: AttentionState = EMPTY_ATTENTION;
  /** The panes the renderer says are on screen — meaningless alone; see visibleNames(). */
  private onScreen: string[] = [];
  private badge = '';

  constructor(private hooks: AttentionHooks) {}

  /** The renderer tells us which session panes are tiled on screen whenever that changes. */
  setOnScreen(names: readonly string[]): void {
    this.onScreen = [...new Set(names.map((n) => String(n ?? '').trim()).filter(Boolean))];
  }

  /** On screen AND the window actually in front. Behind another app, nothing is visible. */
  private visibleNames(): string[] {
    return this.hooks.appVisible() ? this.onScreen : [];
  }

  /** One observation. Called from the same 2s poll that already lists the sessions.
   *  Returns the finished-unseen names so the tab strip can mark them (#24.2b) — the counter
   *  and the tab marker are the SAME state, so deriving it twice would let them disagree. */
  tick(running: readonly RunningAgent[], level: NotifyLevel): string[] {
    const sessions = running.map((a) => ({ name: a.name, status: a.status, waitingFor: a.waitingFor }));
    const r = attentionTick(this.state, sessions, this.visibleNames());
    this.state = r.state;

    const want = badgeText(r.badge, level);
    if (want !== this.badge) {
      this.badge = want;
      /* setBadgeCount is the cross-platform spelling (macOS Dock, Linux Unity); it is a no-op
         on Windows, where a count belongs on a taskbar overlay icon rather than a badge. */
      try { app.setBadgeCount(r.badge > 0 && level !== 'off' ? r.badge : 0); } catch { /* headless / unsupported */ }
    }

    if (!mayBanner(level) || !r.pending.length) return r.unread;
    if (!Notification.isSupported()) return r.unread;

    const delivered: string[] = [];
    for (const s of r.pending) {
      const pid = running.find((a) => a.name === s.name)?.pid;
      try {
        const n = new Notification({
          title: t('notify.blockedTitle', { name: s.name }),
          body: s.waitingFor || t('notify.blockedBody'),
          silent: false,
        });
        /* Focus the pane, never answer for them: approving a permission from a banner would be
           a decision taken on a surface that cannot show what is being approved. */
        n.on('click', () => { if (pid !== undefined) this.hooks.reveal(pid); });
        n.show();
        delivered.push(s.name);
      } catch { /* not delivered → stays pending, and the next tick tries again */ }
    }
    // ONLY what the OS accepted. A banner that threw must not be remembered as shown.
    this.state = markNotified(this.state, delivered);
    return r.unread;
  }

  /** Clear the badge when the App is going away, so the Dock does not keep a stale number. */
  dispose(): void {
    try { app.setBadgeCount(0); } catch { /* nothing to clear */ }
  }
}
