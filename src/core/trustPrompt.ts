/**
 * #182: a session the bus starts can stop on Claude Code's folder-trust question, and nobody sees it.
 *
 * Every bus spawn and resume passes `--add-dir` on a fresh private handoff folder
 * (~/.aios/run/handoff-<hex>). Since Claude Code 2.1.326 a folder that is not trusted yet raises
 * "Adding a new directory … Is this a directory you created or one you trust?" before the session
 * starts. The bus opens that tab in the background, so the request looked delivered while the
 * session waited on a question nobody saw: no transcript, no registry entry, no dead letter.
 *
 * The App never answers it: trusting a folder is the operator's call (canonical aios#323). It notices
 * the question, marks the tab, tells the operator once, and leaves a dead letter naming why, so the
 * sender knows the work has not started. Trusting ~/.aios/run once covers every later handoff folder.
 * Pure, so the matching can be tested without a terminal.
 */

/** How long after a bus tab opens it is watched for the question. The question is the first thing it shows. */
export const TRUST_WATCH_MS = 120_000;

/* The wordings Claude Code uses for its folder-trust question: the added-directory form and the
   working-folder form. Matched on whitespace-collapsed plain text, because a TUI breaks lines and
   pads with spaces wherever it likes. */
const TRUST_PATTERNS: readonly RegExp[] = [
  /is this a directory you created or one you trust/i,
  /do you trust the files in this folder/i,
  /yes,? i trust this folder/i,
];

/** A terminal stream as plain words: every escape sequence and control character becomes a space,
 *  because a TUI moves the cursor between words instead of printing spaces. */
export function plainForTrust(raw: string): string {
  return String(raw || '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, ' ')    // OSC (titles, links)
    .replace(/\x1b\[[0-9;?<>=]*[ -\/]*[@-~]/g, ' ')         // CSI (cursor moves, colours)
    .replace(/\x1b[@-_]/g, ' ')                               // other two-byte escapes
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ');
}

/** Is Claude Code asking whether to trust a folder? `text` is plain (see plainForTrust). */
export function isTrustPrompt(text: string): boolean {
  const flat = String(text || '').replace(/\s+/g, ' ');
  /* The question AND its numbered Yes choice: the shell echoes the command line first, and a task
     typed inline that merely mentions the question must not trip it (review of #182). */
  return TRUST_PATTERNS.some((re) => re.test(flat)) && /\b1\.\s*Yes\b/i.test(flat);
}

/** A tab worth watching: started with `--add-dir`, which is what raises the question for a new folder. */
export function watchesForTrust(cmd: string | undefined): boolean {
  return /(^|\s)--add-dir(\s|=)/.test(String(cmd || ''));
}

/** The reason written into the dead letter and shown to the operator. One sentence of what, one of how. */
export function trustBlockedReason(name: string): string {
  return `'${name}' is waiting on Claude Code's question about trusting its task folder, so it has not started. `
    + 'Answer it in that tab. To stop the question for every later spawn, trust ~/.aios/run once: run `cd ~/.aios/run && claude`, choose Yes, then /exit.';
}
