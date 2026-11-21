/**
 * Claude answers in the App's language.
 *
 * Claude Code has its own `language` setting ("Preferred language for Claude responses and voice
 * dictation", read out of its settings schema): set, every session's system prompt says "Always
 * respond in <language>"; unset, Claude matches the language the operator writes in. The App never
 * connected its interface language to it, so an operator who chose French saw a French App and got
 * English answers: every ritual and the setup brief reach Claude as English instructions, and Claude
 * matched those.
 *
 * Pure: no fs, no electron. aios.ts reads the stores, asks `decideClaudeLanguage`, writes the result.
 */

/* The value written into Claude's `language` key, per App locale. English is null on purpose: unset
   means "match the operator", which is already right for an English App and also for an English App
   whose operator writes in another language. Names in English, as Claude's own examples are
   ("japanese", "spanish"); it is inserted into "Always respond in …". */
export const CLAUDE_LANGUAGE: Record<string, string | null> = {
  en: null,
  es: 'Spanish',
  'pt-br': 'Brazilian Portuguese',
  el: 'Greek',
  fr: 'French',
};

export function claudeLanguageFor(locale: string): string | null {
  return Object.prototype.hasOwnProperty.call(CLAUDE_LANGUAGE, locale) ? CLAUDE_LANGUAGE[locale] : null;
}

export type LanguageAction = { kind: 'set'; value: string } | { kind: 'unset' } | { kind: 'keep' };

const named = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/**
 * What to do with `language` in the vault's LOCAL store (`<root>/.claude/settings.local.json`),
 * the one every session the App launches reads first.
 *
 * The App only ever owns a value it wrote itself, remembered as `synced`:
 *   - a local value the App did not write is the operator's choice (`/config`, by hand): kept;
 *   - a value in the global or project store is also the operator's: the App steps aside, and
 *     removes its own local value, which would otherwise outrank theirs (local wins in Claude);
 *   - otherwise the local value follows the App's language, and is removed for English.
 */
export function decideClaudeLanguage(s: { local?: unknown; elsewhere?: unknown; synced?: unknown; target: string | null }): LanguageAction {
  const ours = named(s.local) && s.local === s.synced;
  if (named(s.local) && !ours) return { kind: 'keep' };
  if (named(s.elsewhere)) return ours ? { kind: 'unset' } : { kind: 'keep' };
  if (s.target === null) return ours ? { kind: 'unset' } : { kind: 'keep' };
  if (s.local === s.target) return { kind: 'keep' };
  return { kind: 'set', value: s.target };
}
