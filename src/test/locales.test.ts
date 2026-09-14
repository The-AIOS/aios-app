/**
 * Every UI string exists in every locale.
 *
 * A missing key renders as its OWN NAME — `inbox.deadLetter` appears on screen where a sentence
 * should be. It is not a crash, nothing logs, and it is only ever visible to someone running
 * the app in that language, which for this repo means it ships.
 *
 * Until now each feature asserted its own strings ("all three locales carry the download
 * strings", "every connector string exists in all three locales"). That works exactly until
 * someone adds a feature and not the test — the same hole `LADDER_TOOLS` had. This derives the
 * universe from the files instead, so a key added to one locale and forgotten in another fails
 * here whether or not anyone remembered to write a test for that feature.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const DIR = path.join(__dirname, '..', '..', 'src', 'i18n', 'locales');
const load = (l: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(path.join(DIR, `${l}.json`), 'utf8')) as Record<string, unknown>;

/* `$`-prefixed keys are file METADATA, not UI strings — `$meta` carries the locale's own name
   for the language picker and is an object. Key parity still covers them (a locale missing its
   own name is a real bug); the string assertions below must not read them as broken sentences.
   Named as a convention rather than a special case for `$meta`, so the next one is covered. */
const isMeta = (k: string): boolean => k.startsWith('$');
const strings = (l: string): [string, string][] =>
  Object.entries(load(l)).filter(([k]) => !isMeta(k)) as [string, string][];

/** Derived from the directory — a fourth locale is covered the day it is added. */
const LOCALES = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();

test('the locale set is discovered, not assumed', () => {
  assert.ok(LOCALES.includes('en'), 'en is the reference locale');
  assert.ok(LOCALES.length >= 3, `expected at least three locales, found ${LOCALES.join(', ')}`);
});

test('no locale declares the same key twice', () => {
  /* JSON.parse KEEPS THE LAST duplicate and reports nothing, so every other test in this file
     is blind to this: a second `"settings.notify"` lower down silently replaces the first and
     the parsed object looks perfectly healthy. Measured — adding a Desktop-alerts row under a
     key that already belonged to the phone-push row overwrote that row's label in all three
     locales, and only an unrelated test asserting the old string exposed it. So this reads the
     TEXT, which is the only place a duplicate still exists. */
  for (const loc of LOCALES) {
    const raw = fs.readFileSync(path.join(DIR, `${loc}.json`), 'utf8');
    const seen = new Set<string>();
    const dupes = new Set<string>();
    for (const m of raw.matchAll(/^\s*"([^"]+)"\s*:/gm)) {
      if (seen.has(m[1])) dupes.add(m[1]);
      seen.add(m[1]);
    }
    assert.deepEqual([...dupes], [],
      `${loc} declares ${dupes.size} key(s) twice — JSON.parse keeps the LAST silently, so the ` +
      `earlier value is dead and whatever used it now shows the wrong string: ${[...dupes].join(', ')}`);
  }
});

test('every locale carries exactly the keys en carries', () => {
  const en = Object.keys(load('en')).sort();
  for (const loc of LOCALES) {
    if (loc === 'en') continue;
    const keys = Object.keys(load(loc)).sort();
    const missing = en.filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !en.includes(k));
    assert.deepEqual(missing, [], `${loc} is missing ${missing.length} key(s) — each renders as its own name: ${missing.slice(0, 8).join(', ')}`);
    assert.deepEqual(extra, [], `${loc} carries ${extra.length} key(s) en does not — dead strings, or en is the one missing them: ${extra.slice(0, 8).join(', ')}`);
  }
});

test('every non-metadata value is a real, non-empty string', () => {
  for (const loc of LOCALES) {
    const bad = Object.entries(load(loc))
      .filter(([k, v]) => !isMeta(k) && (typeof v !== 'string' || !v.trim()))
      .map(([k]) => k);
    assert.deepEqual(bad, [], `${loc} has blank or non-string values — an empty label is invisible, not absent: ${bad.slice(0, 8).join(', ')}`);
  }
});

test('the metadata convention holds — every locale names itself, and only $-keys are exempt', () => {
  for (const loc of LOCALES) {
    const meta = load(loc).$meta as { name?: string; nativeName?: string } | undefined;
    assert.ok(meta?.nativeName, `${loc} has no $meta.nativeName — the language picker shows it`);
    const nonString = Object.entries(load(loc)).filter(([k, v]) => !isMeta(k) && typeof v !== 'string').map(([k]) => k);
    assert.deepEqual(nonString, [], `${loc}: a non-string value outside the $ convention — either it is metadata and needs the prefix, or it is a bug: ${nonString.join(', ')}`);
  }
});

test('placeholders survive translation — {name} dropped in one locale is a silently wrong sentence', () => {
  const en = strings('en');
  const ph = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const loc of LOCALES) {
    if (loc === 'en') continue;
    const other = Object.fromEntries(strings(loc));
    const broken: string[] = [];
    for (const [k, v] of en) {
      const a = ph(v), b = ph(other[k] ?? '');
      if (a.join(',') !== b.join(',')) broken.push(`${k} (en: {${a.join('} {')}} vs ${loc}: {${b.join('} {')}})`);
    }
    assert.deepEqual(broken, [], `${loc} changed the placeholders of ${broken.length} string(s): ${broken.slice(0, 6).join(' · ')}`);
  }
});
