/**
 * Claude's language: its own choice, beside the App's (0.17.0).
 *
 * Claude Code has a `language` setting ("Preferred language for Claude responses and voice
 * dictation", from its settings schema): set, every session's system prompt says "Always respond in
 * <language>", which outranks any CLAUDE.md asking Claude to reply in the operator's language; unset,
 * Claude matches the language the operator writes in.
 *
 * The App's interface language and Claude's language are two choices. An operator can run the App in
 * Spanish and write to Claude in English, and changing the App's language must never quietly change
 * how every session answers (hand test of 0.17.0: a first version followed the App's language and a
 * Spanish App suddenly answered English prompts in Spanish, with nothing saying why). So the App only
 * writes `language` when the operator picks it in Settings, and after an App language change it
 * SUGGESTS matching, once, and does nothing unless they say yes.
 *
 * Pure: no fs, no electron. aios.ts reads and writes the store; the renderer asks these.
 */

/* What can be chosen, beside "the language you write in" (no value). The value is what goes into Claude's
   `language` key, in English, as Claude's own examples are ("japanese", "spanish"); it reads as "Always respond
   in …". `locale` is the App locale whose native name labels it. */
export const CLAUDE_LANGUAGES: ReadonlyArray<{ value: string; locale: string }> = [
  { value: 'English', locale: 'en' },
  { value: 'Spanish', locale: 'es' },
  { value: 'Brazilian Portuguese', locale: 'pt-br' },
  { value: 'Greek', locale: 'el' },
  { value: 'French', locale: 'fr' },
];

/* The Claude language that MATCHES an App locale. English is null: unset means "match the operator", which already
   answers in English to English and leaves an English App's operator free to write in anything else. */
export function claudeLanguageFor(locale: string): string | null {
  if (locale === 'en') return null;
  const hit = CLAUDE_LANGUAGES.find((l) => l.locale === locale);
  return hit ? hit.value : null;
}

const norm = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const same = (a: string | null, b: string | null) => (a === null ? b === null : b !== null && a.toLowerCase() === b.toLowerCase());

/** What the App may write: one of the choices, or null to remove the key. Anything else is refused (undefined). */
export function claudeLanguageChoice(v: unknown): string | null | undefined {
  if (v === null || v === '') return null;
  const s = norm(v);
  if (!s) return undefined;
  const hit = CLAUDE_LANGUAGES.find((l) => l.value.toLowerCase() === s.toLowerCase());
  return hit ? hit.value : undefined;
}

/**
 * After the operator changes the App's language: is there a suggestion to make? `current` is the language Claude
 * answers in now (the vault's local value, else the one in Claude's own settings, else null). Returns
 * `{ value }`, the value matching would write (null = "the language you write in"), or null for nothing to ask:
 * Claude already matches, or the App language has no Claude counterpart.
 */
export function claudeLanguageSuggestion(appLocale: string, current: unknown): { value: string | null } | null {
  const known = appLocale === 'en' || CLAUDE_LANGUAGES.some((l) => l.locale === appLocale);
  if (!known) return null;
  const target = claudeLanguageFor(appLocale);
  const cur = norm(current);
  if (same(target, cur)) return null;
  if (target === null && cur !== null && cur.toLowerCase() === 'english') return null;   // an English App with Claude set to English already matches
  return { value: target };
}
