/** app#66, both surfaces: an Ask AIOS session is named for the identity it asks for, and keeps its letters. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askSessionName, askSlug, foldName, datedIdentity, identityNamesIn, explicitName } from '../core/sessionName';

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
