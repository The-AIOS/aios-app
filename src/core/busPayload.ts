/**
 * AI-66 — the bus delivers a POINTER, never a truncated prompt.
 *
 * WHY THIS IS NOT A BYTE COUNT IN A CONTRACT
 * ------------------------------------------
 * A ~2.6KB bus send arrived cut at byte 2043, mid-sentence, with no error anywhere. The
 * dropped tail carried a "do NOT push" instruction; it was caught only because the cut
 * happened to land mid-phrase.
 *
 * The ceiling was then MEASURED rather than assumed, and it turned out not to be one number:
 *
 *   App pty, canonical mode  1024 bytes exactly   (MAX_CANON — intact at 1024, cut at 1100)
 *   App pty, raw mode        no ceiling observed  (intact at 200,000 bytes)
 *   Glass, term.sendText()   not measurable here  (inside the VS Code extension host; the
 *                                                  field observation was 2043)
 *
 * So the limit is surface-dependent, partly lives in someone else's process, and can move
 * under a dependency upgrade — silently, which is the entire failure mode. A number written
 * into the contract would be one upgrade away from being wrong while still looking right.
 *
 * Therefore the invariant is NOT "messages may be up to N bytes". It is:
 *
 *      ABOVE THE THRESHOLD, DELIVER A POINTER — NEVER THE TEXT.
 *
 * INLINE_LIMIT is 1024 because that is the one ceiling actually measured and reproducible.
 * It is a threshold for CHOOSING THE MECHANISM, not a promise about what survives: below it
 * we inline because we measured that it works; above it we stop relying on measurement at all.
 *
 * The pointer text must be self-executing — a session receiving it has to know what to do
 * without having read any documentation, because a receiving session may be running an older
 * canonical than the one that documents this.
 */

/** The one measured, reproducible ceiling (macOS/Linux MAX_CANON). See the header. */
export const INLINE_LIMIT = 1024;

/** How long a spilled payload stays on disk. They hold arbitrary prompt text, so they age out. */
export const PAYLOAD_TTL_MS = 24 * 60 * 60 * 1000;

/** Bytes, not characters — a prompt full of em dashes is longer than its `.length` suggests. */
export function byteLength(text: string): number {
  return Buffer.byteLength(text ?? '', 'utf8');
}

/** Does this prompt have to travel as a file? */
export function needsPointer(text: string): boolean {
  return byteLength(text) > INLINE_LIMIT;
}

/**
 * The line actually typed into the session. Deliberately explicit and self-contained:
 *  - it names the file and the action in one sentence, so no prior knowledge is needed;
 *  - it says WHY, so the receiver does not treat a pointer as the whole instruction;
 *  - it is one line, because the bus types text and a newline submits.
 * Must stay comfortably under INLINE_LIMIT — it is the thing that must never be truncated.
 */
export function pointerText(file: string): string {
  return (
    `Read ${file} and follow the full instructions inside it. ` +
    `That file IS the message — this line is only a pointer, because the message was longer ` +
    `than the command bus delivers inline. Do not act on this line alone.`
  );
}

/** A payload file is stale once it is older than the TTL. Pure so it can be tested. */
export function isStalePayload(mtimeMs: number, now: number): boolean {
  return now - mtimeMs > PAYLOAD_TTL_MS;
}

/**
 * Guard for the caller that thinks it is delivering inline. Returns the text unchanged when
 * it fits, and throws when it does not — because the one thing a fulfiller must never do is
 * write a partial prompt and report success. Callers that can spill should call needsPointer
 * first; this exists so a caller that CANNOT spill fails loudly instead of truncating.
 */
export function assertDeliverable(text: string): string {
  if (needsPointer(text)) {
    throw new Error(
      `bus: refusing to deliver ${byteLength(text)} bytes inline (limit ${INLINE_LIMIT}) — ` +
      `spill to a payload file and deliver a pointer instead`,
    );
  }
  return text;
}
