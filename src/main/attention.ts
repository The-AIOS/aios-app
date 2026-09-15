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

/**
 * WINDOWS HAS NO DOCK BADGE, and `setBadgeCount` is a silent no-op there — so on Windows the
 * count this whole feature produces reached the operator nowhere at all. The taskbar equivalents
 * are an OVERLAY ICON (a small glyph on the taskbar button) and FLASHING the button.
 *
 * These two functions are the decisions; the drawing and the API calls are below them. Split
 * that way because the calls cannot be exercised on the machine this is written on: an
 * untestable API wrapped around an untested decision is two unknowns, and only one of them has
 * to stay unknown.
 */

/** Text for the taskbar overlay. '' clears it. Two characters is all a 16px overlay can hold. */
export function overlayText(count: number, level: NotifyLevel): string {
  if (level === 'off' || count <= 0) return '';
  return count > 9 ? '9+' : String(count);
}

/**
 * Should the taskbar button flash?
 *
 * Only for a block the operator has NOT already seen, and only while the window is not focused.
 * Flashing at someone who is looking at the app is the notification equivalent of shouting in a
 * quiet room — and on Windows the flash persists until the window is activated, so a flash
 * raised while focused would never clear itself.
 */
export function shouldFlash(pendingCount: number, focused: boolean, level: NotifyLevel): boolean {
  return level !== 'off' && pendingCount > 0 && !focused;
}

export interface AttentionHooks {
  /** Bring the App forward and focus the pane running this session. */
  reveal(target: { name: string; sessionId?: string }): void;
  /** Tell the operator something they have to act on outside this app. Fired at most once. */
  notifyBlocked(): void;
  /** Windows taskbar: draw `text` on the button ('' clears), described for screen readers. */
  setOverlay(text: string, description: string): void;
  /** Windows taskbar: flash the button until the operator activates the window. */
  flash(on: boolean): void;
  /** Is the window focused right now? Decides whether flashing would be shouting. */
  isFocused(): boolean;
}

export class Attention {
  private state: AttentionState = EMPTY_ATTENTION;
  private badge = '';
  /** Failed banner attempts per block — bounded, so an OS that will not show notifications is
   *  not retried every two seconds for the life of the process. */
  private failures = new Map<string, number>();
  /** Said once, ever: the OS is refusing, and only the operator can change that. */
  private toldAboutPermission = false;
  /** Windows taskbar flash, mirrored so it is only ever toggled on a change. */
  private flashing = false;
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
      /* The Windows half of the same fact. Driven by the SAME change check, so the two surfaces
         cannot disagree about the count — and only on a change, because redrawing an overlay
         every two seconds is the class of bug AI-157 was. */
      const ov = overlayText(r.badge, level);
      try { this.hooks.setOverlay(ov, ov ? t('notify.overlayDesc', { n: String(r.badge) }) : ''); }
      catch { /* not Windows, or the window went away */ }
    }

    /* FLASH ON WHAT IS NEW, not on what is outstanding. `r.pending` is the blocks not yet
       announced, so a session that has been waiting for an hour does not re-flash every tick;
       a newly blocked one does. Cleared when the operator activates the window — Windows keeps
       flashing until then, which is the behaviour we want and also why it must never be raised
       while focused. */
    try {
      const flash = shouldFlash(r.pending.length, this.hooks.isFocused(), level);
      if (flash !== this.flashing) { this.flashing = flash; this.hooks.flash(flash); }
    } catch { /* not Windows, or the window went away */ }

    if (!mayBanner(level) || !r.pending.length) return;
    if (!Notification.isSupported()) return;

    for (const s of r.pending) {
      /* Resolve the pane by IDENTITY, not by name: with two sessions called `ingest`, a
         name lookup reveals whichever one happens to come first. */
      const hit = running.find((a) => sessionKey(a) === s.id);
      try {
        const n = new Notification({
          title: t('notify.blockedTitle', { name: s.name }),
          body: s.waitingFor || t('notify.blockedBody'),
          silent: false,
        });
        /* Focus the pane, never answer for them: approving a permission from a banner would be
           a decision taken on a surface that cannot show what is being approved.
           NAME + SESSION ID, not the pid. The renderer resolves a pane by `sessionId` and falls
           back to `name` — it has no pid index at all, because a pane object never stores one. So
           sending `{ pid }` resolved to nothing and the click raised the window and then toasted
           "isn't a pane in this window" instead of focusing the session that was waiting. It went
           unseen because the only machine testing it had two installed bundles, and the banner was
           opening the OTHER one before this code ever ran. */
        n.on('click', () => {
          if (hit) this.hooks.reveal({ name: hit.name, sessionId: hit.sessionId });
        });
        /* DELIVERY IS ASYNCHRONOUS, and this is what was wrong. `show()` does not throw and
           returns immediately — the OS reports the outcome later, on these events. Marking the
           block notified beside `show()` therefore recorded a banner that never appeared:
           measured on an unsigned dev build, every notification came back
           `failed: UNErrorDomain error 1` (notifications not allowed) while this counted each
           one as delivered. That is the detected/pending/accepted collapse the request warned
           about, reached from the one direction a try/catch cannot see. */
        n.on('show', () => { this.failures.delete(s.id); });
        n.on('failed', () => {
          const tries = (this.failures.get(s.id) ?? 0) + 1;
          this.failures.set(s.id, tries);
          /* Retry, but only up to the bound — after three refusals the OS is not changing its
             mind this run. Give up on the BANNER only: the block keeps its place in the badge,
             so nothing vanishes quietly. */
          if (tries < MAX_BANNER_TRIES) {
            this.state = { notified: this.state.notified.filter((k) => k !== s.id) };
          } else {
            /* AND SAY SO. Giving up silently is how an operator concludes the feature is broken:
               they set it to "badge + notification", nothing ever appears, and nothing anywhere
               explains that macOS is refusing. Reported exactly that — the banners only worked
               after finding System Settings unaided. The App is the only party that KNOWS the OS
               refused, so it is the only one that can say it. Once per run, never a nag. */
            if (!this.toldAboutPermission) {
              this.toldAboutPermission = true;
              try { this.hooks.notifyBlocked(); } catch { /* the surface went away */ }
            }
          }
        });
        /* MARKED ON THE ATTEMPT, and only un-marked if the OS comes back to say it failed.
           This was the other way round, on the reasoning that `show()` does not throw and a
           refusal arrives asynchronously — true, and it assumed one of the two events ALWAYS
           arrives. Operator-reported 2026-09-15: with notifications revoked in system settings,
           a signed build got neither. Nothing appeared, and nothing said why — but the block
           also stayed `pending`, so this loop built a fresh notification every two seconds, for
           as long as that session stayed blocked. Silence is not a verdict we can wait on.
           Marking here is the honest reading: what we can observe is that we ASKED. */
        this.state = markNotified(this.state, [s.id]);
        n.show();
      } catch { /* constructor threw → stays pending, and the next tick tries again */ }
    }
  }

  /** Clear the badge when the App is going away, so the Dock does not keep a stale number. */
  dispose(): void {
    try { app.setBadgeCount(0); } catch { /* nothing to clear */ }
    /* A taskbar overlay OUTLIVES the window it was set on if it is not cleared, and a flashing
       button that nothing can stop is worse than no signal at all. */
    try { this.hooks.setOverlay('', ''); } catch { /* not Windows */ }
    try { this.hooks.flash(false); } catch { /* not Windows */ }
  }
}
