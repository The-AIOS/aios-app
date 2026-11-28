/**
 * Was today PLANNED? Not "does today's note exist".
 *
 * The "Plan your day" nudge used to ask whether today's daily note exists. Three writers create
 * that file without planning anything: `/close-session` appends its `## Session —` block (and
 * creates the note when it is missing), `/close-day` appends `## Close of Day`, and Glass's kill
 * guard harvests a killed session's post-its into it. After any of them the nudge went quiet for
 * the rest of the day, and from 17:00 it asked to close a day that was never planned.
 *
 * So the question is asked of the CONTENT: does the note hold a section `/aios:today` writes? Its
 * output template has fixed section headings (`## Rhythm`, `## Today I ship`, `## Parking lot`,
 * `## Claude's take`, `## Agents can handle`; a first run writes `## Recommended next step`). They
 * are the template's words, not the operator's language: a vault whose notes are titled in Spanish
 * still carries them in English. Glass already reads one of them (`Agents can handle`) to find
 * agent suggestions.
 *
 * Two signals that look reasonable and are not: the `plan` tag in the frontmatter, and a title
 * such as "Daily Plan". Notes rebuilt after the fact by a close-day copy both without planning
 * anything; on one live vault the tag alone marked 47 such notes as planned, the title 9.
 *
 * Why a positive signal and not "anything besides the known appenders": a list of appenders goes
 * stale silently. The next writer that appends to the daily note would turn the nudge off again,
 * which is this defect. A missing heading fails loudly instead: the nudge keeps asking, and someone
 * notices.
 *
 * Level-2 headings only: `/close-day` writes `### Rhythm check`, which must not count. A heading
 * quoted inside a fenced code block does not count either. A `/7plan` skeleton for the day (it
 * writes `## Today I ship`, `## Rhythm`, `## Parking lot`) counts as planned: that day was planned,
 * a week ahead. Pure, so the App and Glass share it through `src/core/` (the App copies this
 * folder with `sync-core`).
 */

/* An emoji or other symbol may lead the heading text (`## 🤖 Agents can handle`); letters may not. */
const PLAN_SECTIONS =
  /^##[ \t]+[^\w\n]*(?:Rhythm|Today I ship|Parking lot|Claude['’]s take|Agents can handle|Recommended next step)\b/im;
/* A fence is three or more backticks (whose info text holds no backtick, so inline ```code``` is not
   one) or tildes, closed by the same run. A longer fence may hold shorter ones. Unclosed hides nothing. */
const FENCED = /^[ \t]*(`{3,}(?=[^`\n]*$)|~{3,})[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm;

export function dayPlanned(md: string): boolean {
  return PLAN_SECTIONS.test(String(md || '').replace(FENCED, ''));
}

/** From this hour an unplanned day is left to the afternoon and evening nudges. */
export const PLAN_UNTIL_HOUR = 15;

/**
 * Should the nudge ask to plan today? `md` is today's note, or null when there is none; `closed`
 * is the caller's own close-of-day test. Both surfaces ask this first, before any other nudge.
 *
 * - No note: yes, at any hour, as before.
 * - A note, unplanned and not closed: yes until PLAN_UNTIL_HOUR. From then on the day behaves
 *   exactly as it did when the note's existence was the only test: closing open sessions from
 *   15:00, closing the day from 17:00. Planning a day that late helps nobody, and those two nudges
 *   are what gather a worked day's session blocks.
 * - Planned or closed: no.
 */
export function asksToPlan(md: string | null, hour: number, closed: boolean): boolean {
  if (md === null) return true;
  if (closed || dayPlanned(md)) return false;
  return hour < PLAN_UNTIL_HOUR;
}
