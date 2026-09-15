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
  attentionTick, markNotified, badgeText, mayBanner, sessionKey,
  EMPTY_ATTENTION, type AttentionState, type NotifyLevel,
} from '../core/attention';
import type { RunningAgent } from './aios';
import { t } from '../i18n';

/** Banner attempts per block before giving up on the BANNER (the badge is unaffected). */
const MAX_BANNER_TRIES = 3;

export interface AttentionHooks {
  /** Bring the App forward and focus the pane running `pid`. */
  reveal(pid: number): void;
}

export class Attention {
  private state: AttentionState = EMPTY_ATTENTION;
  private badge = '';
  /** Failed banner attempts per block — bounded, so an OS that will not show notifications is
   *  not retried every two seconds for the life of the process. */
  private failures = new Map<string, number>();

  constructor(private hooks: AttentionHooks) {}

  /** One observation. Called from the same 2s poll that already lists the sessions. */
  tick(running: readonly RunningAgent[], level: NotifyLevel): void {
    const sessions = running.map((a) => ({
      id: sessionKey(a), name: a.name, status: a.status, waitingFor: a.waitingFor,
    }));
    const r = attentionTick(this.state, sessions);
    this.state = r.state;

    const want = badgeText(r.badge, level);
    if (want !== this.badge) {
      this.badge = want;
      /* setBadgeCount is the cross-platform spelling (macOS Dock, Linux Unity); it is a no-op
         on Windows, where a count belongs on a taskbar overlay icon rather than a badge. */
      try { app.setBadgeCount(r.badge > 0 && level !== 'off' ? r.badge : 0); } catch { /* headless / unsupported */ }
    }

    if (!mayBanner(level) || !r.pending.length) return;
    if (!Notification.isSupported()) return;

    for (const s of r.pending) {
      /* Resolve the pane by IDENTITY, not by name: with two sessions called `ingest`, a
         name lookup reveals whichever one happens to come first. */
      const pid = running.find((a) => sessionKey(a) === s.id)?.pid;
      try {
        const n = new Notification({
          title: t('notify.blockedTitle', { name: s.name }),
          body: s.waitingFor || t('notify.blockedBody'),
          silent: false,
        });
        /* Focus the pane, never answer for them: approving a permission from a banner would be
           a decision taken on a surface that cannot show what is being approved. */
        n.on('click', () => { if (pid !== undefined) this.hooks.reveal(pid); });
        /* DELIVERY IS ASYNCHRONOUS, and this is what was wrong. `show()` does not throw and
           returns immediately — the OS reports the outcome later, on these events. Marking the
           block notified beside `show()` therefore recorded a banner that never appeared:
           measured on an unsigned dev build, every notification came back
           `failed: UNErrorDomain error 1` (notifications not allowed) while this counted each
           one as delivered. That is the detected/pending/accepted collapse the request warned
           about, reached from the one direction a try/catch cannot see. */
        n.on('show', () => {
          this.failures.delete(s.id);
          this.state = markNotified(this.state, [s.id]);
        });
        n.on('failed', () => {
          const tries = (this.failures.get(s.id) ?? 0) + 1;
          this.failures.set(s.id, tries);
          /* Bounded: after three refusals the OS is not changing its mind this run, and
             retrying every two seconds forever is its own bug. Give up on the BANNER only —
             the block keeps its place in the badge, so nothing vanishes quietly. */
          if (tries >= MAX_BANNER_TRIES) this.state = markNotified(this.state, [s.id]);
        });
        n.show();
      } catch { /* constructor threw → stays pending, and the next tick tries again */ }
    }
  }

  /** Clear the badge when the App is going away, so the Dock does not keep a stale number. */
  dispose(): void {
    try { app.setBadgeCount(0); } catch { /* nothing to clear */ }
  }
}
