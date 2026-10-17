/**
 * A folder, or a file outside the allowed roots, printed in a terminal was not a link at all —
 * no underline, no error. The resolver only answered "an allowed FILE", because it existed to
 * feed the viewer, which reads what it opens. Operator-reported: an agent named the folder of a
 * finished deliverable (in its temp scratchpad) and the only way to it was copying the path into
 * Finder's "Go to folder".
 *
 * Revealing reads nothing, so it does not need the roots: the resolver now answers two maps,
 * `open` (gated, unchanged) and `reveal` (any absolute path that exists, folders included).
 * Run against real files; the renderer half is source-asserted like revealFromTerminal.test.ts.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveLinkTargets, revealable, type LinkEnv } from '../main/pathLinks';

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aios-links-')));
const root = path.join(tmp, 'aios');            // stands in for the allowed roots
const outside = path.join(tmp, 'scratch');      // an agent's temp folder
fs.mkdirSync(path.join(root, 'hooks'), { recursive: true });
fs.mkdirSync(path.join(outside, 'story'), { recursive: true });
fs.writeFileSync(path.join(root, 'notes.md'), '# hi\n');
fs.writeFileSync(path.join(outside, 'story', 'chapter.mp3'), 'x');

const stat: LinkEnv['stat'] = (abs) => { try { return fs.statSync(abs); } catch { return null; } };
const env: LinkEnv = {
  allowed: (abs) => abs === root || abs.startsWith(root + path.sep),   // native separator: Windows CI
  bases: [root, tmp],
  home: tmp,
  stat,
};

test('an allowed file still opens in the viewer — the gate the preview depends on is unchanged', () => {
  const p = path.join(root, 'notes.md');
  assert.deepEqual(resolveLinkTargets([p], env), { open: { [p]: p }, reveal: {} });
});

test('a folder becomes a reveal link, inside the roots or out', () => {
  const inside = path.join(root, 'hooks');
  const out = path.join(outside, 'story');
  const r = resolveLinkTargets([inside, out + '/'], env);
  assert.deepEqual(r.open, {}, 'the viewer never gets a folder');
  assert.equal(r.reveal[inside], inside);
  assert.equal(r.reveal[out + '/'], out, 'a trailing slash still resolves (to the normalized path)');
});

test('a file outside the roots is reveal-only: Finder may show it, the viewer may not read it', () => {
  const p = path.join(outside, 'story', 'chapter.mp3');
  assert.deepEqual(resolveLinkTargets([p], env), { open: {}, reveal: { [p]: p } });
});

test('~/ expands before the check, and :line suffixes and trailing punctuation are dropped', () => {
  const r = resolveLinkTargets(['~/scratch/story),', '~/aios/notes.md:12'], env);
  assert.equal(r.reveal['~/scratch/story),'], path.join(outside, 'story'));
  assert.equal(r.open['~/aios/notes.md:12'], path.join(root, 'notes.md'));
});

test('a RELATIVE token never becomes reveal-only — ordinary words that name a folder stay text', () => {
  // `scratch/story` exists under the second base (tmp), outside the roots: no link.
  assert.deepEqual(resolveLinkTargets(['scratch/story', 'hooks'], env), { open: {}, reveal: {} });
  // inside the roots a relative FILE still opens, as before
  assert.equal(resolveLinkTargets(['notes.md'], env).open['notes.md'], path.join(root, 'notes.md'));
});

test('a path that does not exist is no link at all', () => {
  assert.deepEqual(resolveLinkTargets([path.join(outside, 'nope.mp3'), '/no/such/dir'], env), { open: {}, reveal: {} });
});

test('a network path is never stat\'ed for a reveal link — hovering text must not reach a host', () => {
  /* Windows authenticates to a UNC host on stat (an NTLM hash, from text anyone could print);
     macOS automounts /net and /Network. The stat itself is the leak, so assert it never runs. */
  const seen: string[] = [];
  const spy: LinkEnv = { ...env, stat: (abs) => { seen.push(abs); return stat(abs); } };
  const net = ['\\\\evil\\share\\x.png', '//evil/share/x', '\\\\?\\UNC\\evil\\x', '/net/evil/x', '/Network/Servers/evil',
               '/NET/evil/x', '/./net/evil/x', '/tmp/../net/evil/x'];
  assert.deepEqual(resolveLinkTargets(net, spy), { open: {}, reveal: {} });
  /* On POSIX a backslash string is RELATIVE and may resolve inside the roots as a local name, as
     it always did; what must never happen is a stat of the network path itself. */
  const reached = () => seen.filter((s) => net.includes(s) || /^\/(net|network)\//i.test(s));
  assert.deepEqual(reached(), [], 'no network path reached stat');
  for (const p of net) assert.equal(revealable(p, spy.stat), null, p);
  assert.deepEqual(reached(), []);
});

test('shell:reveal accepts any absolute path that exists, and nothing else', () => {
  assert.equal(revealable(path.join(outside, 'story'), stat), path.join(outside, 'story'));
  assert.equal(revealable(path.join(outside, 'story', '.', '..', 'story'), stat), path.join(outside, 'story'), 'normalized');
  assert.equal(revealable(path.join(outside, 'nope'), stat), null);
  assert.equal(revealable('story', stat), null, 'relative paths fall back to the roots-resolved path');
  assert.equal(revealable(undefined, stat), null);
});

const app = fs.readFileSync('renderer/app.js', 'utf8');

test('renderer: a reveal-only link reveals on ⌘-click too, and says so on hover', () => {
  const i = app.indexOf('activate: (ev) => {');
  assert.ok(i >= 0, 'the path-link activate handler moved?');
  const act = app.slice(i, i + 1600);
  const shift = act.indexOf('if (ev.shiftKey) { void window.glassShell.revealInOS(abs); return; }');
  const revealOnly = act.indexOf('if (!canOpen) { void window.glassShell.revealInOS(abs); return; }');
  const preview = act.indexOf('void openViewer(abs);');
  assert.ok(shift >= 0 && revealOnly > shift && preview > revealOnly,
    'the viewer is reached only when the target may be opened');
  const h = app.indexOf('hover: (ev) => showPathTip(');
  assert.match(app.slice(h, h + 500), /t\(IS_WIN \? 'term\.cmdClickRevealWin' : 'term\.cmdClickReveal'\)/);
});

test('every locale names the reveal-only gesture, with the right keys per platform', () => {
  for (const loc of ['en', 'es', 'pt-br']) {
    const j = JSON.parse(fs.readFileSync(`src/i18n/locales/${loc}.json`, 'utf8')) as Record<string, string>;
    assert.match(j['term.cmdClickReveal'], /^⌘-/, `${loc} term.cmdClickReveal`);
    assert.match(j['term.cmdClickRevealWin'], /^Ctrl\+/, `${loc} term.cmdClickRevealWin`);
    assert.doesNotMatch(j['term.cmdClickRevealWin'], /⌘|⇧|Finder/, `${loc} Windows string names no macOS keys`);
  }
});
