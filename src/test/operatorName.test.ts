/**
 * WHO IS THE OPERATOR — across languages.
 *
 * Reported 2026-07-30 by an operator whose `about_me.md` reads "Me llamo Ignacio Indaco.": the
 * app greeted him as a brand-new vault. `operatorName()` matched `my name is` and nothing else,
 * so a fully personalised Spanish vault was indistinguishable from an untouched one — in an app
 * that ships es / es-419 / pt-BR and invites you to work in your own language.
 *
 * Two properties are tested, and the second is the one that made it expensive to diagnose:
 *   1. the name resolves regardless of the language it was written in
 *   2. when the vault IS written but no name can be read, that is REPORTABLE — not silently
 *      degraded into "brand-new vault", which is what sent the reporter looking at his own file
 */
import { test, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as aios from '../main/aios';

let root = '';
const ABOUT = path.join('vault', '00 - notes', 'context', 'declared', 'about_me.md');

/** Write an about_me and point aios at a throwaway framework root. */
function about(body: string): void {
  const p = path.join(root, ABOUT);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-opname-'));
  process.env.GLASS_FRAMEWORK_PATH = root;
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# fixture\n');
});

/* ── the reported case, verbatim ─────────────────────────────────────────────── */

test('FIELD CASE: "Me llamo Ignacio Indaco." resolves to Ignacio', () => {
  about('Soy diseñador y fundador de una agencia. Me llamo Ignacio Indaco. Trabajo en Buenos Aires.\n');
  assert.equal(aios.operatorName(), 'Ignacio',
    'the exact line from the field report must resolve — and to the FIRST name only');
});

test('every language the app itself speaks resolves a name', () => {
  const cases: Array<[string, string]> = [
    ['Hi — my name is Tester and I build things.', 'Tester'],
    ['Me llamo Ignacio y construyo cosas.', 'Ignacio'],
    ['Mi nombre es Dolores, trabajo en producto.', 'Dolores'],
    ['Meu nome é João e eu construo coisas.', 'João'],
    ['I am called Sam.', 'Sam'],
  ];
  for (const [line, want] of cases) {
    about(line + '\n');
    assert.equal(aios.operatorName(), want, `failed for: ${line}`);
  }
});

test('accents and ñ survive — the range must cover the locales that ship', () => {
  about('Mi nombre es Íñigo, encantado.\n');
  assert.equal(aios.operatorName(), 'Íñigo');
});

/* ── precedence: structured beats prose, explicit beats inferred ─────────────── */

test('FIELD CASE 2: lowercase link aliases must NOT beat a properly-cased prose name', () => {
  /* The real vault that caught this, verbatim. In Obsidian `aliases:` exists so LINKS resolve,
     so lowercase slugs are the norm there — they are not display names. Preferring them greeted
     the operator as "chuy" off his own link aliases while his prose said the properly-cased
     answer. Structured-beats-prose was the wrong instinct for this particular field. */
  about('---\naliases:\n  - chuy\n  - chuycepeda\n---\n\nMy name is Jesús “Chuy” Cepeda.\n');
  assert.equal(aios.operatorName(), 'Chuy',
    'the quoted nickname is the display name; the aliases are slugs');
});

test('aliases are still the net when the prose cannot be parsed', () => {
  // No identity phrase at all — this is the case aliases exist to rescue, and the reason the
  // field stays in the chain rather than being dropped after the regression above.
  about('---\naliases:\n  - Nacho\n---\n\nDiseño productos y dirijo un estudio en Buenos Aires.\n');
  assert.equal(aios.operatorName(), 'Nacho');
});

test('aliases also works inline and as a bare scalar', () => {
  about('---\naliases: [Nacho, Ignacio]\n---\n\nnothing else here\n');
  assert.equal(aios.operatorName(), 'Nacho');
  about('---\naliases: Nacho\n---\n\nnothing else here\n');
  assert.equal(aios.operatorName(), 'Nacho');
});

test('a lowercase-only name IS normalised — deliberate reversal, 2026-07-30', () => {
  /* This test previously asserted the opposite, and the change was a decision, not a drift.
     I argued for leaving a lowercase name alone on the grounds that some people write their own
     name that way. The operator overruled it: the common case by far is a link slug leaking into
     the greeting, and being greeted by a slug looks broken to everyone, while being capitalised
     mildly annoys a rare few. The cost is accepted and named, and the bound that keeps it from
     over-reaching is the deliberate-casing test below. */
  about('---\naliases:\n  - bell\n---\n\nnothing parseable here\n');
  assert.equal(aios.operatorName(), 'Bell', 'a bare lowercase candidate is displayed as a name');
});

test('a quoted nickname beats the parsed word', () => {
  about('Me llamo Ignacio, pero todos me dicen "Nacho".\n');
  assert.equal(aios.operatorName(), 'Nacho');
});

/* ── and the silence that cost the reporter his afternoon ────────────────────── */

test('THE GAP IS REPORTABLE: written vault, unreadable name, must not look virgin', () => {
  /* Long, placeholder-free, unmistakably personal — so hasIdentity() passes — but phrased in a
     way no phrase list catches. Before the fix this greeted as a brand-new vault and said
     nothing; the operator concluded his own file was malformed. */
  about('Diseño productos desde 2009 y dirijo un pequeño estudio en Buenos Aires. '
    + 'Trabajo sobre todo con equipos que están reinventando su relación con la tecnología, '
    + 'y me interesa la parte humana mucho más que la técnica. Escribo, enseño y construyo.\n');
  assert.equal(aios.operatorName(), '', 'no name is readable from this text');
  assert.equal(aios.hasIdentity(), true, 'but the vault is unmistakably written');
  assert.equal(aios.identityNameGap(), true,
    'the disagreement between the two readings must be REPORTABLE, never silent');
});

test('a genuinely empty vault is NOT a gap — that distinction is the whole point', () => {
  about('');
  assert.equal(aios.identityNameGap(), false,
    'an unwritten vault has no name for honest reasons and must not raise a warning');
});

test('the gap closes as soon as a name is readable', () => {
  about('---\naliases:\n  - Nacho\n---\n\nDiseño productos desde 2009 y dirijo un estudio.\n');
  assert.equal(aios.identityNameGap(), false);
});

test('INVARIANT: every reading path is still present, and none can be dropped quietly', () => {
  /* Both mechanisms must survive: the phrase list is what makes a Spanish vault work, and
     `aliases:` is what rescues a vault whose prose we cannot parse at all. The ORDER between
     them was the bug in both directions, so it is asserted by behaviour above rather than by
     source position here — a position assertion would have passed on both wrong versions. */
  const src = fs.readFileSync('src/main/aios.ts', 'utf8');
  const fn = /export function operatorName\(\): string \{[\s\S]*?\n\}/.exec(src);
  assert.ok(fn, 'operatorName must be findable');
  assert.match(fn![0], /aliasFromFrontmatter/, 'the language-agnostic net must remain');
  assert.match(fn![0], /IDENTITY_PHRASE/, 'the multi-language phrase read must remain');
  assert.match(fn![0], /\[A-ZÀ-Þ\]/, 'and the display-name preference, which is what fixed the slug case');
});

/* ── DISPLAY FORM ──────────────────────────────────────────────────────────────
   Requested 2026-07-30: whatever the source, the greeting should read like a name — initial
   cap, rest lower — so an operator is never addressed by a link slug. Bounded deliberately:
   it fires only when there is no internal casing worth preserving. */

test('a slug or a shout becomes a name', () => {
  for (const [given, want] of [['chuy', 'Chuy'], ['CHUY', 'Chuy'], ['ignacio', 'Ignacio']]) {
    about(`---\naliases:\n  - ${given}\n---\n\nno parseable prose\n`);
    assert.equal(aios.operatorName(), want, `${given} should display as ${want}`);
  }
});

test('accents survive the round trip — locale-aware casing, not ASCII', () => {
  about('---\naliases:\n  - JOSÉ\n---\n\nnada\n');
  assert.equal(aios.operatorName(), 'José', 'a naive toUpperCase/charAt fix mangles this');
  about('---\naliases:\n  - íñigo\n---\n\nnada\n');
  assert.equal(aios.operatorName(), 'Íñigo');
});

test('hyphens and apostrophes get their own capital', () => {
  about('---\naliases:\n  - jean-luc\n---\n\nnada\n');
  assert.equal(aios.operatorName(), 'Jean-Luc');
  about("---\naliases:\n  - o'brien\n---\n\nnada\n");
  assert.equal(aios.operatorName(), "O'Brien");
});

test('DELIBERATE CASING IS NEVER REWRITTEN — the bound that keeps this from being rude', () => {
  /* The whole risk of normalising a person's name is over-reach. A string that already carries
     internal casing is a decision someone made, and "correcting" it would be the same insult in
     the opposite direction from greeting them by a slug. */
  for (const name of ['McDonald', "O'Brien", 'DeAndre', 'LaTanya']) {
    about(`---\naliases:\n  - ${name}\n---\n\nno prose\n`);
    assert.equal(aios.operatorName(), name, `${name} must pass through untouched`);
  }
});

test('the real vault still resolves to Chuy — normalisation must not disturb a good answer', () => {
  about('---\naliases:\n  - chuy\n  - chuycepeda\n---\n\nMy name is Jesús “Chuy” Cepeda.\n');
  assert.equal(aios.operatorName(), 'Chuy');
});
