/** app#66, both surfaces: an Ask AIOS session is named for the identity it asks for, and keeps its letters. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askSessionName, askSlug, foldName, datedIdentity, identityNamesIn, explicitName, uniqueName } from '../core/sessionName';

const OCT16 = new Date(2026, 9, 16);
const USER_MD = [
  '## Identity', '',
  '| Name | Role | Greeting style |', '|---|---|---|',
  '| `atlas-TT-MM-JJ` | main session of the day | warm |',
  '| `parallel-atlas-TT-MM-JJ` | second session | brief |',
  '| `buddai` | coordinator | friendly |', '',
  '## Next section',
].join('\n');

test('letters are folded, never dropped (für → fuer, not f-r)', () => {
  assert.equal(foldName('für Straße Ärger'), 'fuer strasse aerger');
  assert.equal(foldName('canción niño'), 'cancion nino');
  assert.equal(askSlug('Plan für morgen'), 'ask-plan-morgen', 'German filler dropped after folding');
});

test('the reported case: a German sentence naming a dated identity gets today\'s session', () => {
  const identities = identityNamesIn(USER_MD);
  assert.deepEqual([...identities], ['atlas-tt-mm-jj', 'parallel-atlas-tt-mm-jj', 'buddai']);
  assert.equal(askSessionName('Starte bitte atlas für den Tag', { identities, now: OCT16 }), 'atlas-16-10-26');
  assert.equal(askSessionName('start parallel atlas', { identities, now: OCT16 }), 'parallel-atlas-16-10-26', 'longest stem wins');
});

test('Spanish, Portuguese and German filler words are dropped like English ones', () => {
  assert.equal(askSlug('Prepara el reporte semanal'), 'ask-prepara-reporte-semanal');
  assert.equal(askSlug('Preciso de uma proposta para o cliente'), 'ask-proposta-cliente');
  assert.equal(askSlug('Bitte die Rechnung für den Kunden'), 'ask-rechnung-kunden');
  assert.equal(askSlug('plan fur morgen'), 'ask-plan-morgen', 'für typed without the umlaut');
});

test('a name the operator SAYS wins: "a session named rumi" → rumi', () => {
  assert.equal(askSessionName('run a session named rumi and help me derive a new poem from my projects'), 'rumi');
  assert.equal(askSessionName('abre una sesión llamada Poesía para escribir'), 'poesia');
  assert.equal(askSessionName('crie uma sessão chamada relatorio-semanal'), 'relatorio-semanal');
  assert.equal(askSessionName('starte eine Sitzung namens Übersicht'), 'uebersicht');
  assert.equal(askSessionName('open a session called "deck-v2"'), 'deck-v2');
  assert.equal(askSessionName('run a session named rumi', { live: ['rumi'] }), 'rumi-2', 'a live name is never reused');
  assert.equal(explicitName('rename the file'), undefined, 'a word merely containing "name" is not a naming phrase');
  assert.equal(explicitName('help me name my startup'), undefined, '"name my" is not "named X"');
  assert.equal(explicitName('dame el nombre del cliente'), undefined, 'a bare "nombre" is content, not a naming phrase');
  assert.equal(explicitName('qual é o nome do projeto'), undefined, 'nor a bare "nome"');
  assert.equal(explicitName('una sesión con nombre rumi'), 'rumi');
});

test('a naming word only names the SESSION — "llamada" is also a phone call, "called" also a document', () => {
  // reviewer, measured on the 0.12.0 candidate: each of these became a session named after the next word
  assert.equal(explicitName('prepara la llamada con Cavimex'), undefined);
  assert.equal(explicitName('agenda una llamada para mañana con Diego'), undefined);
  assert.equal(explicitName('resume la chamada com o cliente'), undefined);
  assert.equal(explicitName('summarize the doc called Q3 plan'), undefined);
  assert.equal(explicitName('open the file named report.pdf'), undefined, '"named" a file is not naming the session');
  // and the descriptive name is what they get instead
  assert.equal(askSessionName('prepara la llamada con Cavimex'), 'ask-prepara-llamada-cavimex');
  // the session word may have a word or two before the naming phrase
  assert.equal(explicitName('start a new session named rumi'), 'rumi');
  assert.equal(explicitName('abre una sesión nueva llamada rumi'), 'rumi');
  assert.equal(explicitName('spawn an agent called scout'), 'scout');
  // filler is never a name, even right after a session word
  assert.equal(explicitName('una sesión llamada para revisar'), undefined);
  // verb first: "call this session X"
  assert.equal(explicitName('llama a esta sesion perro y luego'), 'perro');
  assert.equal(explicitName('llama a esta sesión perro'), 'perro');
  assert.equal(explicitName('call this session perro'), 'perro');
  assert.equal(explicitName('name the session perro'), 'perro');
  assert.equal(explicitName('chama esta sessão de perro'), 'perro');
  assert.equal(explicitName('nenne diese Sitzung perro'), 'perro');
  // and a call that is not about the session still names nothing
  assert.equal(explicitName('llama a Diego para la sesion de mañana'), undefined, 'the word after the session noun is filler');
  assert.equal(explicitName('call the client about the session'), undefined);
});

test('a plain identity is never auto-picked — it names the live session being talked ABOUT', () => {
  const identities = identityNamesIn(USER_MD);
  assert.equal(askSessionName('ask buddai to review the deck', { identities, now: OCT16 }), 'ask-ask-buddai-review');
});

test('a name already running is never handed out again', () => {
  const identities = identityNamesIn(USER_MD);
  assert.equal(askSessionName('start atlas', { identities, live: ['Atlas-16-10-26'], now: OCT16 }), 'ask-start-atlas', 'today\'s atlas is live → descriptive name');
  assert.equal(askSessionName('start atlas', { identities, live: ['Atlas-16-10-26', 'ask-start-atlas'], now: OCT16 }), 'ask-start-atlas-2');
});

test('date placeholders: DD/TT, MM, YY/JJ, YYYY/JJJJ; a name without a full date is not dated', () => {
  assert.equal(datedIdentity('daily-YYYY-MM-DD')!.fill(OCT16), 'daily-2026-10-16');
  assert.equal(datedIdentity('atlas-TT-MM-JJ')!.stem, 'atlas');
  assert.equal(datedIdentity('atlas-MM'), undefined);
  assert.equal(datedIdentity('TT-MM-JJ'), undefined, 'no stem to match on');
});

test('no intent words → ask-intent, as before', () => {
  assert.equal(askSessionName('please help me do it'), 'ask-intent');
  assert.equal(askSessionName('i need a social media strategy'), 'ask-social-media-strategy');
});

test('uniqueName: a name an open tab or live session already has gets -2, -3…', () => {
  assert.equal(uniqueName('buddai', ['buddai']), 'buddai-2');
  assert.equal(uniqueName('buddai', ['Buddai', 'buddai-2']), 'buddai-3', 'case-insensitive, and skips taken suffixes');
  assert.equal(uniqueName('rumi', []), 'rumi');
});
