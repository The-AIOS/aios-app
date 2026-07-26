/**
 * Tiny dependency-free i18n for the AIOS app (MAIN process).
 *
 * One source of truth: the locale JSON bundles in `src/i18n/locales/`. The
 * renderer gets the SAME bundles via the generated `renderer/i18n.js`
 * (`npm run gen-i18n`, run automatically by `compile`) — keep them in sync by
 * editing the JSON, never the generated file.
 *
 * `core/*.ts` (shared with aios-glass) carries NO UI strings — it is pure data
 * models. So nothing here needs to live in `core/`. See the i18n report.
 */
import en from './locales/en.json';
import es from './locales/es.json';
import ptbr from './locales/pt-br.json';

export type Locale = 'en' | 'es' | 'pt-br';
export const LOCALES: Locale[] = ['en', 'es', 'pt-br'];

/** A user's stored language preference: a concrete locale, or `auto` (follow the OS). */
export type LocalePref = 'auto' | Locale;

// Bundles carry a `$meta` object alongside string keys, so cast via unknown.
const bundles: Record<Locale, Record<string, string>> = {
  en: en as unknown as Record<string, string>,
  es: es as unknown as Record<string, string>,
  'pt-br': ptbr as unknown as Record<string, string>,
};

export function localeMeta(): { code: Locale; name: string; nativeName: string }[] {
  return LOCALES.map((code) => {
    const meta = (bundles[code] as unknown as { $meta?: { name?: string; nativeName?: string } }).$meta || {};
    return { code, name: meta.name || code, nativeName: meta.nativeName || code };
  });
}

let current: Locale = 'en';
export function getLocale(): Locale { return current; }
export function setLocale(loc: string | undefined | null): Locale {
  current = normalizeLocale(loc);
  return current;
}

/** Map any BCP-47-ish tag (e.g. from app.getLocale()) to a supported locale. */
export function normalizeLocale(loc: string | undefined | null): Locale {
  const s = (loc || '').toLowerCase();
  if (s.startsWith('es')) return 'es';
  if (s.startsWith('pt')) return 'pt-br';
  return 'en';
}

/** Validate a stored preference: `auto` (default), or a concrete supported locale. */
export function normalizeLocalePref(v: string | undefined | null): LocalePref {
  const s = (v || '').toLowerCase();
  if (s === 'auto' || s === '') return 'auto';
  if (s === 'en' || s === 'es') return s;
  if (s.startsWith('pt')) return 'pt-br';
  if (s.startsWith('es')) return 'es';
  return 'auto';
}

/** Translate a key with optional `{var}` interpolation. Falls back en → key. */
export function t(key: string, vars?: Record<string, string | number>): string {
  const b = bundles[current] || bundles.en;
  let s = b[key];
  if (s === undefined) s = bundles.en[key];
  if (s === undefined) return key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : `{${k}}`));
  return s;
}
