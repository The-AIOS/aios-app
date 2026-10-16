/** app#66, both surfaces: an Ask AIOS session is named for the identity it asks for, and keeps its letters. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askSessionName, askSlug, foldName, datedIdentity, identityNamesIn } from '../core/sessionName';

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
  assert.equal(askSlug('Plan für morgen'), 'ask-plan-fuer-morgen');
});

test('the reported case: a German sentence naming a dated identity gets today\'s session', () => {
  const identities = identityNamesIn(USER_MD);
  assert.deepEqual([...identities], ['atlas-tt-mm-jj', 'parallel-atlas-tt-mm-jj', 'buddai']);
  assert.equal(askSessionName('Starte bitte atlas für den Tag', { identities, now: OCT16 }), 'atlas-16-10-26');
  assert.equal(askSessionName('start parallel atlas', { identities, now: OCT16 }), 'parallel-atlas-16-10-26', 'longest stem wins');
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
