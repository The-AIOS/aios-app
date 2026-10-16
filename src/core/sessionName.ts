/**
 * Session names for an Ask AIOS intent — pure, shared by Glass and the App (sync-core).
 *
 * app#66: an operator whose vault maps session names to identities (`atlas-TT-MM-JJ` in USER.md)
 * started her day's main session through Ask AIOS with a German sentence, and got
 * `ask-starte-bitte-atlas-f-r-d`. Two defects: the identity the sentence named was ignored, and
 * `für` lost its letter. The descriptive `ask-…` name stays the default — for everyone else it is
 * what makes the Running list readable — but:
 *
 *  · LETTERS ARE FOLDED, NEVER DROPPED. German umlauts take their spelled form (für → fuer,
 *    Straße → strasse), every other accent loses only its mark (canción → cancion).
 *  · A DATED IDENTITY IS PICKED when the intent names its stem. A USER.md identity whose name
 *    carries a date pattern (`atlas-TT-MM-JJ`, `daily-DD-MM-YY`) is a per-day session by
 *    construction, so "start atlas" means today's one: `atlas-16-10-26`. Only DATED identities are
 *    auto-picked. A plain one (`buddai`) usually names the long-running session the intent is
 *    talking ABOUT, and picking it would start a second `buddai` beside the live one, which the
 *    bus can no longer tell apart.
 *  · A name already live is never reused.
 */

/** Spell out what a slug would otherwise drop. */
export function foldName(s: string): string {
  return String(s ?? '')
    .replace(/[äÄ]/g, 'ae').replace(/[öÖ]/g, 'oe').replace(/[üÜ]/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/* Filler words dropped from the descriptive name, in the languages AIOS operators write in. Compared
   against FOLDED words, so German entries are spelled folded (für → fuer) — and also as typed without
   the umlaut (fur), which is how it arrives from a keyboard that has none. "Prepara el reporte
   semanal" → ask-prepara-reporte-semanal, not ask-prepara-el-reporte. */
const STOP = new Set([
  // en
  'i', 'a', 'an', 'the', 'to', 'for', 'of', 'on', 'in', 'at', 'by', 'my', 'me', 'our', 'we', 'us', 'you', 'your', 'it', 'is', 'are', 'am', 'and', 'or', 'with', 'about', 'need', 'needs', 'want', 'wants', 'please', 'can', 'could', 'should', 'would', 'like', 'help', 'make', 'create', 'do', 'get', 'give', 'let', 'lets', 'some', 'this', 'that', 'new', 'have', 'has',
  // es
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'al', 'en', 'por', 'para', 'con', 'sin', 'y', 'o', 'que', 'mi', 'mis', 'tu', 'tus', 'su', 'sus', 'te', 'se', 'lo', 'le', 'les', 'es', 'son', 'este', 'esta', 'esto', 'ese', 'esa', 'eso', 'favor', 'necesito', 'quiero', 'ayudame', 'ayuda', 'hazme', 'haz', 'dame', 'puedes', 'podrias', 'sobre',
  // pt
  'os', 'as', 'um', 'uma', 'do', 'da', 'dos', 'das', 'no', 'na', 'nos', 'nas', 'em', 'sem', 'e', 'ou', 'meu', 'minha', 'seu', 'sua', 'eu', 'voce', 'preciso', 'quero', 'faca', 'pode',
  // de
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'und', 'oder', 'fuer', 'fur', 'mit', 'von', 'zu', 'im', 'am', 'an', 'auf', 'ich', 'du', 'mein', 'meine', 'bitte', 'mir', 'mich', 'ist', 'sind',
]);

/** The descriptive name: content words of the intent, folded. "i need a social media strategy" → ask-social-media-strategy. */
export function askSlug(intent: string): string {
  const words = foldName(intent).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w));
  const core = (words.length ? words : ['intent']).slice(0, 3).join('-');
  return ('ask-' + core).slice(0, 28).replace(/-+$/, '');
}

/* Date placeholders, per dash-separated segment. TT/JJ are the German spellings of DD/YY. */
const DAY = new Set(['dd', 'tt']);
const MONTH = new Set(['mm']);
const YEAR2 = new Set(['yy', 'jj']);
const YEAR4 = new Set(['yyyy', 'jjjj']);
const isPlaceholder = (seg: string) => DAY.has(seg) || MONTH.has(seg) || YEAR2.has(seg) || YEAR4.has(seg);

/** `atlas-tt-mm-jj` → { stem: 'atlas', fill(date) } — or undefined when the name carries no full date. */
export function datedIdentity(name: string): { stem: string; fill: (d: Date) => string } | undefined {
  const segs = foldName(name).split('-').filter(Boolean);
  const ph = segs.filter(isPlaceholder);
  const has = (set: Set<string>) => ph.some((s) => set.has(s));
  if (!has(DAY) || !has(MONTH) || !(has(YEAR2) || has(YEAR4))) return undefined;
  const stemSegs = segs.filter((s) => !isPlaceholder(s));
  if (!stemSegs.length) return undefined;
  const p2 = (n: number) => String(n).padStart(2, '0');
  return {
    stem: stemSegs.join('-'),
    fill: (d) => segs.map((s) => (DAY.has(s) ? p2(d.getDate()) : MONTH.has(s) ? p2(d.getMonth() + 1)
      : YEAR2.has(s) ? p2(d.getFullYear() % 100) : YEAR4.has(s) ? String(d.getFullYear()) : s)).join('-'),
  };
}

export interface AskNameOptions {
  /** USER.md Identity names (any case). */
  identities?: Iterable<string>;
  /** Names of sessions already running — never handed out again. */
  live?: Iterable<string>;
  now?: Date;
}

/* A name the operator SAID wins over any guess: "run a session named rumi and …" → rumi (operator
   test, 0.12.0, which got ask-run-session-named).

   ONLY WHEN IT NAMES THE SESSION. "llamada"/"chamada" are also "a phone call", and "named"/"called"
   name files and documents too: "prepara la llamada con Cavimex" became `con`, "summarize the doc
   called Q3 plan" became `q3` (reviewer, 0.12.0). So a naming phrase counts only after a SESSION
   word — "session", "sesión", "sessão", "Sitzung", "agent" — with up to two words between ("a new
   session named rumi"), and a captured word that is filler (con, para, com…) is never a name.
   Matched on the FOLDED intent, so "sesión" and "sessão" need no accented spellings here. */
const SESSION_NOUN = '(?:session|sesion|sessao|sitzung|agent|agente)';
const NAMING = '(?:named|called|name it|nombrada|nombrado|llamada|llamado|que se llame|con nombre|con el nombre|chamada|chamado|com o nome|namens|genannt|mit dem namen)';
const NAMED = new RegExp(`(?:^|[^a-z0-9])${SESSION_NOUN}(?:\\s+[a-z0-9-]+){0,2}?\\s+${NAMING}\\s+["'“‘«]?([a-z0-9][a-z0-9._-]*)`);
/* The VERB-FIRST form: "llama a esta sesión perro", "call this session perro", "chama esta sessão de
   perro", "nenne diese Sitzung perro" (operator test, 0.12.0). A naming verb, up to two words, the
   session word, an optional "de/como/as", then the name. */
const NAMING_VERB = '(?:call|name|llama|llamale|nombra|nombrale|ponle de nombre|chama|chame|nomeia|nomeie|nenne|benenne)';
const NAMED_VERB_FIRST = new RegExp(`(?:^|[^a-z0-9])${NAMING_VERB}(?:\\s+[a-z0-9-]+){0,2}?\\s+${SESSION_NOUN}\\s+(?:(?:de|como|as)\\s+)?["'“‘«]?([a-z0-9][a-z0-9._-]*)`);
export function explicitName(intent: string): string | undefined {
  const folded = foldName(intent);
  const m = NAMED.exec(folded) ?? NAMED_VERB_FIRST.exec(folded);
  if (!m) return undefined;
  const n = m[1].replace(/^[-.]+|[-.]+$/g, '').slice(0, 48);
  return n && !STOP.has(n) ? n : undefined;
}

/** `base`, or `base-2`, `base-3`… — the first that no live session (or open tab) already has. */
export function uniqueName(base: string, live: Iterable<string>, max = 48): string {
  const taken = new Set([...live].map((n) => foldName(n)));
  if (!taken.has(foldName(base))) return base;
  for (let n = 2; n < 100; n++) { const v = `${base.slice(0, max - String(n).length - 1)}-${n}`; if (!taken.has(v)) return v; }
  return base;
}

export function askSessionName(intent: string, opts: AskNameOptions = {}): string {
  const live = new Set([...(opts.live ?? [])].map((n) => foldName(n)));
  const said = explicitName(intent);
  if (said) return uniqueName(said, live);
  const words = ' ' + foldName(intent).replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
  /* Longest stem first, so `parallel-atlas-…` wins over `atlas-…` for "start parallel atlas". */
  const dated = [...(opts.identities ?? [])].map(datedIdentity).filter((x): x is NonNullable<typeof x> => !!x)
    .sort((a, b) => b.stem.length - a.stem.length);
  for (const id of dated) {
    if (!words.includes(' ' + id.stem.replace(/-/g, ' ') + ' ')) continue;
    const name = id.fill(opts.now ?? new Date());
    if (!live.has(name)) return name;
  }
  return uniqueName(askSlug(intent), live, 28);
}

/** Names from USER.md's Identity table — under `## Identity`, or found by its header row anywhere. Lowercased. */
export function identityNamesIn(text: string): Set<string> {
  const out = new Set<string>();
  const lines = String(text ?? '').split(/\r?\n/);
  const cells = (l: string) => l.split('|').slice(1, -1).map((c) => c.replace(/`/g, '').trim());
  const isHeader = (l: string) => { const c = cells(l).map((x) => x.toLowerCase()); return c[0] === 'name' && c.includes('role'); };
  let start = lines.findIndex((l) => /^##\s+Identity/.test(l));
  if (start === -1) start = lines.findIndex((l) => l.startsWith('|') && isHeader(l)) - 1;
  if (start < -1) return out;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) break;
    if (!line.startsWith('|')) { if (out.size) break; continue; }   // the table ended
    const raw = cells(line)[0] ?? '';
    if (raw && raw.toLowerCase() !== 'name' && !/^[ :-]+$/.test(raw)) out.add(raw.toLowerCase());
  }
  return out;
}
