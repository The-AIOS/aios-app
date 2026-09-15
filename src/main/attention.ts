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
  /** Tell the operator something they have to act on outside this app. Fired at most once. */
  notifyBlocked(): void;
  /** Last observed refusal, from the previous run. */
  loadRefused(): boolean;
  /** Remember the refusal across runs — see the note on `refused`. */
  saveRefused(v: boolean): void;
}

export class Attention {
  private state: AttentionState = EMPTY_ATTENTION;
  private badge = '';
  /** Failed banner attempts per block — bounded, so an OS that will not show notifications is
   *  not retried every two seconds for the life of the process. */
  private failures = new Map<string, number>();
  /** Said once, ever: the OS is refusing, and only the operator can change that. */
  private toldAboutPermission = false;
  /* THE REFUSAL IS A STATE, NOT AN EVENT — which is what the toast alone got wrong. A toast
     fires once and is gone; "macOS is denying notifications" stays true until the operator
     changes it, and the moment they go looking is when they open Settings, not the moment it
     failed. So it is also readable, and Settings renders it beside the control it explains.
     AND IT OUTLIVES THE RUN, which the first version got wrong in a way that made it read as
     simply broken. It was in-memory, so it could only be true if a session happened to block
     while the OS was refusing IN THIS RUN — and Settings is usually opened in a later one.
     Reported 2026-09-15: "no amber line, i closed and opened settings, turned on and off the
     notifications permission, nothing." Every part of the chain was wired; the state was just
     empty, because a relaunch had cleared the only evidence we had. A fact about the operator's
     SYSTEM has no business living in the lifetime of one process — it stays true until a banner
     actually succeeds, and only a successful `show` clears it. */
  private refused: boolean | undefined;

  /** True while macOS is refusing banners — last measured, not guessed. */
  osRefused(): boolean {
    if (this.refused === undefined) {
      try { this.refused = this.hooks.loadRefused(); } catch { this.refused = false; }
    }
    return this.refused;
  }

  /** Record an outcome once, and only when it CHANGES — this writes to disk. */
  private setRefused(v: boolean): void {
    if (this.osRefused() === v) return;
    this.refused = v;
    try { this.hooks.saveRefused(v); } catch { /* unwritable — in-memory still holds for this run */ }
  }

  /**
   * Show one banner on purpose, because the operator just chose to receive banners.
   *
   * The one moment a notification is SELF-EXPLANATORY rather than noise: they picked the level
   * in Settings and the banner is the answer. It is also the only proactive probe available —
   * Electron exposes no way to ask macOS whether we are authorized, and the honest alternatives
   * are worse (reading Apple's private notification database, or inferring from silence). So the
   * amber line appears the moment the setting is chosen and cannot be delivered, instead of
   * waiting for some session to block later and hoping the operator is in Settings when it does.
   */
  /**
   * Re-measure ONLY if we currently believe we are blocked. Called when Settings opens.
   *
   * This is what keeps a PERSISTED state from going stale in the one direction that matters.
   * The warning clears on any successful banner, but nothing guarantees one happens: an operator
   * who fixes the permission and then simply opens Settings would be told they are still blocked,
   * by a line whose whole purpose is to be trusted.
   *
   * Gating on the refused state is what makes it free. While we are genuinely blocked the probe
   * is invisible BY CONSTRUCTION — the OS refuses it, which is the measurement — so the common
   * case costs nothing and shows nothing. Exactly one banner is ever raised: the one that
   * announces the problem is over. Probing unconditionally here would instead fire a banner every
   * time Settings is opened for any reason, which is how a confirmation becomes noise.
   */
  recheck(level: NotifyLevel): void {
    if (!this.osRefused()) return;
    this.probe(level);
  }

  probe(level: NotifyLevel): void {
    if (!mayBanner(level) || !Notification.isSupported()) return;
    try {
      const n = new Notification({ title: t('notify.probeTitle'), body: t('notify.probeBody'), silent: true });
      n.on('show', () => this.setRefused(false));
      n.on('failed', () => this.setRefused(true));
      n.show();
    } catch { /* constructor threw — nothing measured, so nothing claimed */ }
  }

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
          this.setRefused(false);   // granted since — the state must not stick
          this.failures.delete(s.id);
          this.state = markNotified(this.state, [s.id]);
        });
        n.on('failed', () => {
          this.setRefused(true);
          const tries = (this.failures.get(s.id) ?? 0) + 1;
          this.failures.set(s.id, tries);
          /* Bounded: after three refusals the OS is not changing its mind this run, and
             retrying every two seconds forever is its own bug. Give up on the BANNER only —
             the block keeps its place in the badge, so nothing vanishes quietly. */
          if (tries >= MAX_BANNER_TRIES) {
            this.state = markNotified(this.state, [s.id]);
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
        n.show();
      } catch { /* constructor threw → stays pending, and the next tick tries again */ }
    }
  }

  /** Clear the badge when the App is going away, so the Dock does not keep a stale number. */
  dispose(): void {
    try { app.setBadgeCount(0); } catch { /* nothing to clear */ }
  }
}
