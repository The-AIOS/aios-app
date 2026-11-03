/**
 * Read aloud. What of a final answer is worth SPEAKING: prose only, short.
 * Code, tables, file paths and markdown scaffolding are read badly by any voice and belong on
 * screen; a conversation also needs short turns, so a long answer is cut to its first paragraph
 * and says so ("speak short, show long"). Pure.
 */
export const SPEAK_MAX_CHARS = 420;

export function speakable(text: string, restOnScreen: string): string {
  let s = String(text ?? '').replace(/\r\n?/g, '\n');
  s = s.replace(/```[\s\S]*?(```|$)/g, '\n');                    // fenced code
  s = s.replace(/^\s*\|.*\|\s*$/gm, '');                          // table rows
  s = s.replace(/`([^`\n]+)`/g, (_m, c: string) => (/[\\/]|\.\w{1,5}$/.test(c) ? '' : c));   // inline code: keep words, drop paths/files
  s = s.replace(/(?:~|\/Users|\/home|[A-Z]:\\)[^\s)]*/g, '');    // bare paths
  s = s.replace(/https?:\/\/\S+/g, '');                          // links
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');                 // markdown links → text
  s = s.replace(/^#{1,6}\s+/gm, '').replace(/^\s*[-*•]\s+/gm, '').replace(/^\s*>\s?/gm, '');
  /* Emphasis markers only (review nit): stripping EVERY underscore read `session_insights` as
     "sessioninsights". Emphasis underscores sit at word edges; an inner one joins words, and reads
     as a space. */
  s = s.replace(/\*\*|\*/g, '');
  s = s.replace(/([A-Za-z0-9])_+(?=[A-Za-z0-9])/g, '$1 ');   // between letters: a word joint → a space
  s = s.replace(/_/g, '');                                    // what is left is emphasis or an edge
  const paras = s.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!paras.length) return '';
  let first = paras[0];
  let cut = paras.length > 1;
  if (first.length > SPEAK_MAX_CHARS) {
    const sentences = first.match(/[^.!?]+[.!?]+/g) ?? [first];
    let acc = '';
    for (const sent of sentences) { if ((acc + sent).length > SPEAK_MAX_CHARS && acc) break; acc += sent; }
    first = acc.trim() || first.slice(0, SPEAK_MAX_CHARS);
    cut = true;
  }
  return cut ? `${first} ${restOnScreen}` : first;
}

/** The last assistant message's text in a transcript tail, or ''. */
export function lastAnswer(jsonlTail: string): string {
  const lines = String(jsonlTail ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"assistant"')) continue;
    try {
      const r = JSON.parse(lines[i]) as { type?: string; message?: { role?: string; content?: unknown } };
      if (r.type !== 'assistant' && r.message?.role !== 'assistant') continue;
      const c = r.message?.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x: { type?: string }) => x?.type === 'text').map((x: { text?: string }) => x.text ?? '').join('\n') : '';
      if (text.trim()) return text;
    } catch { /* torn line */ }
  }
  return '';
}

/**
 * The answer's language, for choosing a voice: a Spanish answer read by an English voice is
 * unintelligible. A light guess from marker letters and common words; undefined when unsure, in
 * which case the caller uses the App's language.
 */
export function guessLang(text: string): 'es' | 'pt' | 'en' | undefined {
  const s = ` ${String(text ?? '').toLowerCase()} `;
  const count = (re: RegExp) => (s.match(re) || []).length;
  const pt = count(/[ãõç]|\b(não|você|está|também|são|isso|uma)\b/g);
  const es = count(/[ñ¿¡]|\b(el|los|las|que|para|está|también|pero|todo|y)\b/g);
  const en = count(/\b(the|and|is|are|you|this|that|with|for)\b/g);
  const best = Math.max(pt, es, en);
  if (best < 2) return undefined;
  return best === pt && pt > es ? 'pt' : best === es ? 'es' : 'en';
}
