/**
 * Copy last answer — a Claude answer as plain text for WhatsApp, email or a doc. The transcript holds
 * the answer as markdown, so this starts from clean text (no TUI bullets, indents or wrapped lines to
 * undo, which is what made copying from the screen unreliable). Keeps what reads well anywhere:
 * paragraphs, "- " bullets, numbered lines, accents, arrows and dashes. Drops markdown syntax. Pure.
 */
export function answerPlain(md: string): string {
  let s = String(md ?? '').replace(/\r\n?/g, '\n');
  s = s.replace(/^```[^\n]*\n?/gm, '');                              // code fences: keep the code, drop the fence
  s = s.replace(/^#{1,6}\s+/gm, '');                                 // headings → their text
  s = s.replace(/^\s*>\s?/gm, '');                                   // quotes
  s = s.replace(/^(\s*)[*+]\s+/gm, '$1- ');                          // * / + bullets → "- "
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');                    // images → alt text
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, txt: string, url: string) => (txt === url ? url : `${txt} (${url})`));
  s = s.replace(/(\*\*|__)(\S(?:[\s\S]*?\S)?)\1/g, '$2');            // bold
  s = s.replace(/(^|[^\w*])\*(\S(?:[^*\n]*?\S)?)\*(?=[^\w*]|$)/g, '$1$2');   // *italic*
  s = s.replace(/(^|[^\w])_(\S(?:[^_\n]*?\S)?)_(?=[^\w]|$)/g, '$1$2');       // _italic_ (never snake_case)
  s = s.replace(/`([^`\n]+)`/g, '$1');                               // inline code
  s = s.replace(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/gm, '');   // table rule lines
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}
