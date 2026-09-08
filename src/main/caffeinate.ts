/**
 * Keep-awake driver — the only place that touches Electron's power blocker (AI-132).
 *
 * The policy is pure and lives in `src/core/caffeinate.ts`; this file is the part that cannot be
 * pure: it holds the blocker id, reads the live session list, and pushes state at the renderer.
 *
 * WHY MAIN AND NOT THE RENDERER. Two reasons, and the second is the load-bearing one.
 *  1. `powerSaveBlocker` is a main-process API.
 *  2. `renderer/app.js` is a plain <script> with NO access to `src/core` — index.html loads
 *     node_modules UMD bundles, the generated i18n.js, and app.js, and nothing else. A
 *     renderer-side driver could not share the policy, so it would have to reimplement it. That
 *     is the duplication that let a rung table drift in AI-129; here it is avoided by putting the
 *     decision where the shared code can actually be imported.
 *
 * WHAT WE DO NOT DO: shell out to `caffeinate`. It is macOS-only, and the operator's own question
 * was how this works on Windows and Linux. Electron ships the cross-platform primitive, so there
 * is no per-OS command, no PowerShell `SetThreadExecutionState`, and no native addon.
 */
import { powerSaveBlocker } from 'electron';
import {
  BLOCKER_TYPE, anyBusy, desiredBlocker, caffeinateReason, nextOverride,
  type CaffeinateMode, type CaffeinateOverride,
} from '../core/caffeinate';
import * as aios from './aios';

export interface CaffeinateState {
  /** Is the blocker held RIGHT NOW — as Electron reports it, not as we intended. */
  on: boolean;
  mode: CaffeinateMode;
  busy: boolean;
  override: CaffeinateOverride;
  /** A key, not a sentence — the renderer owns the words. */
  reason: 'override-on' | 'override-off' | 'auto-busy' | 'auto-idle' | 'manual-off';
  /** True when we asked for a blocker and the platform did not give us one. See `honest()`. */
  unsupported: boolean;
}

/* Session-scoped by design: an override says "not the usual rule, right now". Persisting it would
   turn a deliberate exception into a setting the operator never chose, and the blocker does not
   survive a restart anyway — so neither should the reason for holding it. */
let override: CaffeinateOverride = null;
let id: number | null = null;
let notify: ((s: CaffeinateState) => void) | null = null;

const log = (m: string): void => console.log('[caffeinate]', m);

/**
 * Whether the blocker is REALLY held, rather than whether we asked for one.
 *
 * `powerSaveBlocker.isStarted(id)` is Electron's own bookkeeping — it does not prove the OS
 * honoured the request. On Linux the blocker goes through D-Bus (`org.freedesktop.ScreenSaver` /
 * logind) and **silently does nothing without a session bus**; this repo's own Linux packaged
 * verify logs `Failed to connect to the bus`, so that is not hypothetical. We cannot detect that
 * from here, which is exactly why the UI must report the state we can observe and say when it may
 * be lying, instead of claiming success because `start()` returned a number.
 *
 * On macOS there IS an independent check — `pmset -g assertions` shows the real assertion — and it
 * is the one the test protocol uses. Deliberately not run from here: a subprocess on every tick to
 * confirm a boolean is a worse trade than telling the truth about what we know.
 */
function held(): boolean {
  return id !== null && powerSaveBlocker.isStarted(id);
}

/** Read the live session list and decide. The busy signal is READ, never re-derived. */
function snapshot(): CaffeinateState {
  const mode = aios.shellSettings().caffeinate;
  const busy = anyBusy(aios.listRunningAgents().map((a) => a.status));
  const want = desiredBlocker({ mode, busy, override });
  return {
    on: held(),
    mode,
    busy,
    override,
    reason: caffeinateReason({ mode, busy, override }),
    /* We wanted it and Electron says we do not have it. On Linux without a session bus this is
       the normal state, and the button must not pretend otherwise. */
    unsupported: want && !held(),
  };
}

/** Apply the decision, then tell the renderer what actually happened. */
function apply(): CaffeinateState {
  const mode = aios.shellSettings().caffeinate;
  const busy = anyBusy(aios.listRunningAgents().map((a) => a.status));
  const want = desiredBlocker({ mode, busy, override });

  if (want && id === null) {
    id = powerSaveBlocker.start(BLOCKER_TYPE);
    log(`held (${BLOCKER_TYPE}) — mode ${mode}, busy ${busy}, override ${String(override)}`);
    if (!powerSaveBlocker.isStarted(id)) {
      /* Asked and refused. Reported once here and surfaced in the UI rather than swallowed — a
         keep-awake that silently does nothing is the failure the whole row exists to remove. */
      log('the platform did not honour the request — on Linux this means no session bus');
    }
  } else if (!want && id !== null) {
    powerSaveBlocker.stop(id);
    id = null;
    log('released');
  }
  const s = snapshot();
  notify?.(s);
  return s;
}

/** Current state without changing anything — for a renderer that just repainted. */
export function state(): CaffeinateState {
  return snapshot();
}

/**
 * The button. Flips the effective state and returns what happened.
 *
 * Clicking back to what the mode would do on its own RELEASES the override rather than pinning an
 * identical value, so `auto` resumes following sessions instead of being frozen at a value that
 * merely matches today. That logic is in core and tested there.
 */
export function toggle(): CaffeinateState {
  const mode = aios.shellSettings().caffeinate;
  const busy = anyBusy(aios.listRunningAgents().map((a) => a.status));
  override = nextOverride({ mode, busy, override });
  log(`toggled → override ${String(override)}`);
  return apply();
}

/**
 * The mode changed in Settings. Drops any override, deliberately.
 *
 * An override is an exception to a rule; changing the rule retires the exception. Keeping it would
 * mean switching manual→auto and watching auto not follow sessions, with nothing on screen
 * explaining why.
 */
export function modeChanged(): CaffeinateState {
  override = null;
  return apply();
}

/**
 * Start the driver. `onState` is how the renderer learns; `tick` is the same cadence the session
 * list already refreshes on, so `auto` reacts as fast as the RUNNING card does and no new poll is
 * introduced for it.
 */
export function init(onState: (s: CaffeinateState) => void, tickMs: number): () => void {
  notify = onState;
  apply();
  const timer = setInterval(apply, tickMs);
  return () => {
    clearInterval(timer);
    /* Release on shutdown. The blocker dies with the process anyway — this is not what makes that
       true, and nothing may come to depend on it. It exists so a quit that lingers does not hold
       the machine awake while it does. */
    if (id !== null) { powerSaveBlocker.stop(id); id = null; }
    notify = null;
  };
}
