/**
 * "Copy as plain text": turn a selection of Claude Code's terminal output into text
 * that reads right when pasted into WhatsApp, Slack, mail or a doc.
 *
 * What a raw copy carries, measured on real output (fixtures/claude-tui-*.json): the `⏺` bullet
 * on the answer's first line, a two-space indent on every line, `▎` quote bars, the `✻ … for 6s`
 * footer, rules of `─`, and — the worst for a paste — a hard newline wherever the terminal
 * wrapped, so every paragraph arrives as a ragged column.
 *
 * Encoding is NOT this function's problem: the App's copy already hands the OS a string. This is
 * only about the shape. Everything here is a heuristic over a TUI, so each rule is conservative:
 * a line is rejoined only when the terminal must have wrapped it (the next word would not have
 * fitted), which keeps short deliberate lines — code, a poem, an address — exactly as they were.
 */

const MARKERS: [RegExp, string][] = [
  [/^(\s*)⏺ /, '$1  '],     // the answer / tool-call bullet → same width, so the indent math holds
  [/^(\s*)❯ /, '$1  '],     // the prompt the operator typed
  [/^(\s*)⎿ {1,2}/, '$1   '], // a tool result's elbow
];
const QUOTE = /^(\s*)▎ ?/;
const LIST = /^(?:[-*•]|\d+[.)])\s/;
const CHROME = [/^─+$/, /^✻ /, /^[⏸⏵]+ /];

interface Line { quote: boolean; text: string; raw: number }

export function plainText(selection: string, cols: number): string {
  const lines: Line[] = [];
  for (const rawLine of String(selection ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    let s = rawLine.replace(/\s+$/, '').replace(/ /g, ' ');
    if (CHROME.some((re) => re.test(s.trim()))) continue;
    const raw = s.length;                                  // width as the terminal laid it out
    for (const [re, to] of MARKERS) s = s.replace(re, to);
    const q = QUOTE.exec(s);
    if (q) s = q[1] + '  ' + s.slice(q[0].length);
    lines.push({ quote: !!q, text: s, raw });
  }

  // Common left indent, over non-empty lines.
  const indents = lines.filter((l) => l.text.trim()).map((l) => /^ */.exec(l.text)![0].length);
  const cut = indents.length ? Math.min(...indents) : 0;

  const out: string[] = [];
  let prev: Line | null = null;
  for (const l of lines) {
    const body = l.text.slice(cut);
    if (!body.trim()) { out.push(''); prev = null; continue; }
    const content = body.trim();
    const firstWord = content.split(/\s/)[0];
    /* Wrapped = the terminal had no room for this line's first word on the previous one. That is
       the only signal that is not a guess; a short previous line was ended on purpose. */
    const wrapped = prev !== null && prev.quote === l.quote && !LIST.test(content)
      && prev.raw + 1 + firstWord.length > cols - 1;
    if (wrapped) out[out.length - 1] += ' ' + content;
    else out.push(l.quote ? '> ' + content : body.replace(/\s+$/, ''));
    prev = l;
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
