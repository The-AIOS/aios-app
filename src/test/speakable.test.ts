/** What gets read aloud: prose, short, never code, tables or paths. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { speakable, lastAnswer, SPEAK_MAX_CHARS } from '../core/speakable';

const REST = 'The rest is on screen.';

test('code, tables, paths and markdown are left on screen', () => {
  const ans = '**Listo.** Cambié `src/main/aios.ts` y probé `npm test`:\n\n```ts\nconst x = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nVer /Users/x/code/file.ts y https://example.com.';
  const s = speakable(ans, REST);
  assert.doesNotMatch(s, /const x|\||\/Users|https|\*\*|aios\.ts/);
  assert.match(s, /^Listo\. Cambié y probé npm test:/);
  assert.ok(s.endsWith(REST), 'there was more than one paragraph');
});

test('a short single paragraph is spoken whole; a long one stops at a sentence', () => {
  assert.equal(speakable('Done — all tests pass.', REST), 'Done — all tests pass.');
  const long = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
  const s = speakable(long, REST);
  assert.ok(s.length <= SPEAK_MAX_CHARS + REST.length + 1);
  assert.match(s, /here\. The rest is on screen\.$/);
});

test('the last assistant text is found in a transcript tail, skipping tool-only turns', () => {
  const tail = [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'First answer.' }] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'next' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Final answer.' }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }),
  ].join('\n');
  assert.equal(lastAnswer(tail), 'Final answer.');
  assert.equal(lastAnswer(''), '');
});

test('the answer\'s language picks the voice; unsure means "use the App\'s"', async () => {
  const { guessLang } = await import('../core/speakable');
  assert.equal(guessLang('Listo. Revisé el código y todo pasa para la entrega.'), 'es');
  assert.equal(guessLang('Pronto. Você está com tudo, e isso não muda nada.'), 'pt');
  assert.equal(guessLang('Done. The tests pass and this is ready for you.'), 'en');
  assert.equal(guessLang('OK.'), undefined);
});
