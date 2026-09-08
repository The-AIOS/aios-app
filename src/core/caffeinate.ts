/**
 * Keep-awake policy — pure decision, no Electron, no fs (AI-132).
 *
 * WHY THIS EXISTS AT ALL. The operator's workaround was a Claude session literally named
 * `caffeinate`, told "caf" / "decaf" — a live agent and its whole context standing in for one
 * boolean. And it failed in the way that matters: when the session died the machine slept and
 * nothing said so. The state was invisible and unverifiable, which is the actual defect; the
 * ceremony was only the symptom.
 *
 * WHY THE POLICY IS HERE AND NOT IN THE RENDERER. `renderer/app.js` is a plain <script> with no
 * access to `src/core` (index.html loads node_modules UMD bundles, the generated i18n.js, and
 * app.js — nothing else). So a renderer-side driver could not share this code, and it would also
 * be the wrong home: the blocker is a main-process API and the busy signal is main-side data. The
 * renderer's job is to SHOW state and send intent. Everything that decides lives here, and main
 * applies it.
 *
 * The mode is an operator setting (`caffeinate: 'manual' | 'auto'`), not a guess.
 */

export type CaffeinateMode = 'manual' | 'auto';

/** `null` = follow the mode. `true`/`false` = the operator has overridden it, this run only. */
export type CaffeinateOverride = boolean | null;

/**
 * The blocker type we request, and why it is not the stronger one.
 *
 * `prevent-app-suspension` keeps the SYSTEM awake and lets the display blank; the ask is an awake
 * machine, not a burning screen. (`prevent-display-sleep` exists and takes precedence over this
 * one per Electron's own docs — offered as a future setting, not a default nobody asked for.)
 *
 * Maps onto what the operator already knows: bare `caffeinate` ≈ this; `caffeinate -d` ≈ the
 * display variant.
 */
export const BLOCKER_TYPE = 'prevent-app-suspension' as const;

/**
 * Is this raw session status a BUSY one?
 *
 * Kept byte-comparable with the renderer's own `statusInfo()` busy branch by
 * `src/test/caffeinate.test.ts`. That duplication is unavoidable — the renderer cannot import
 * this file — so it is GUARDED rather than tolerated: if either side's notion of "busy" moves,
 * the test fails and names both. Exactly the shape that let a rung table drift in AI-129.
 */
export function isBusyStatus(raw: unknown): boolean {
  const st = String(raw ?? '').trim().toLowerCase();
  return st === 'busy' || st === 'working' || st === 'running';
}

/** Any session busy right now? The one input `auto` mode reads. */
export function anyBusy(statuses: readonly unknown[]): boolean {
  return statuses.some(isBusyStatus);
}

/**
 * Should the power blocker be held?
 *
 * `override` wins in BOTH modes, and that is a requirement rather than a convenience — the
 * operator arrived at it independently: *"even in automode, user might want to manually choose to
 * stay awake even if no session is running."* `auto` without an override cannot express the
 * original use case, which was wanting the machine awake at a moment when nothing was running.
 *
 * Note the asymmetry is deliberate: an override of `false` also wins while a session is busy, so
 * "let it sleep, I know what I'm doing" is expressible. Both directions or neither — a one-way
 * override is the kind of half-rule that reads as a bug.
 */
export function desiredBlocker(
  input: { mode: CaffeinateMode; busy: boolean; override: CaffeinateOverride },
): boolean {
  if (input.override !== null) return input.override;
  return input.mode === 'auto' ? input.busy : false;
}

/**
 * What the UI should say — the STATE and its reason, never the action.
 *
 * The failure mode of a toggle is not knowing which way it is set, so the caller renders `on` as
 * the icon's fill and `reason` as the tooltip. `reason` is a key, not a sentence: i18n lives in
 * the renderer and this file has no `t()`.
 */
export function caffeinateReason(
  input: { mode: CaffeinateMode; busy: boolean; override: CaffeinateOverride },
): 'override-on' | 'override-off' | 'auto-busy' | 'auto-idle' | 'manual-off' {
  if (input.override === true) return 'override-on';
  if (input.override === false) return 'override-off';
  if (input.mode === 'manual') return 'manual-off';
  return input.busy ? 'auto-busy' : 'auto-idle';
}

/**
 * Toggling from the button: what the next override becomes.
 *
 * Clicking sets an override OPPOSITE to what is currently effective, so one click always changes
 * something visible — a toggle that appears to do nothing is worse than no toggle. Clicking back
 * to the mode's own answer RELEASES the override (returns to `null`) rather than pinning the same
 * value, so `auto` resumes following sessions instead of being silently frozen at a value that
 * happens to match today.
 */
export function nextOverride(
  input: { mode: CaffeinateMode; busy: boolean; override: CaffeinateOverride },
): CaffeinateOverride {
  const effective = desiredBlocker(input);
  const want = !effective;
  const modeWould = desiredBlocker({ ...input, override: null });
  return want === modeWould ? null : want;
}
