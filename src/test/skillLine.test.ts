/** 0.17: a skill Claude loads is its own line in the chat view ("Loaded skill · name", or "Ran /aios:today"), never folded. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';

const app = fs.readFileSync('renderer/app.js', 'utf8');
const grab = (name: string) => { const m = new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`).exec(app); assert.ok(m, name); return m![0]; };
const fns = new Function(`${grab('chatHatWorn')}\n${grab('chatSkillOf')}\n${grab('chatSkillLookup')}\n${grab('chatSkillBrief')}\nreturn { chatSkillOf, chatSkillLookup, chatSkillBrief };`)() as {
  chatSkillOf: (i: unknown) => { id: string; args: string } | null;
  chatSkillLookup: (id: string, l: unknown) => { kind: string; label: string; desc: string; filePath: string };
  chatSkillBrief: (d: string) => string;
};

test('a Skill call is a skill line; another tool, an empty one, or a hat load is not', () => {
  assert.deepEqual(fns.chatSkillOf({ name: 'Skill', summary: 'brainstorming' }), { id: 'brainstorming', args: '' });
  assert.deepEqual(fns.chatSkillOf({ name: 'Skill', summary: 'aios:today --quick' }), { id: 'aios:today', args: '--quick' });
  assert.equal(fns.chatSkillOf({ name: 'Bash', summary: 'ls' }), null);
  assert.equal(fns.chatSkillOf({ name: 'Skill', summary: '' }), null);
  assert.equal(fns.chatSkillOf({ name: 'Skill', summary: 'aios:agent accountant' }), null, 'the hat card shows an agent load');
});

test('a command reads as "Ran /aios:x", a skill by its name, a plugin prefix matched on the bare name', () => {
  const lists = {
    commands: [{ name: 'today', description: 'Daily plan.', filePath: '/fw/plugins/aios/commands/today.md' }],
    skills: [{ name: 'brainstorming', description: 'Use before creative work. Then more.', filePath: '/fw/skills/superpowers/brainstorming/SKILL.md' }],
  };
  assert.deepEqual(fns.chatSkillLookup('aios:today', lists), { kind: 'command', label: '/aios:today', desc: 'Daily plan.', filePath: '/fw/plugins/aios/commands/today.md' });
  assert.equal(fns.chatSkillLookup('superpowers:brainstorming', lists).filePath, '/fw/skills/superpowers/brainstorming/SKILL.md');
  assert.equal(fns.chatSkillLookup('superpowers:brainstorming', lists).label, 'superpowers:brainstorming');
  assert.equal(fns.chatSkillLookup('brainstorming', lists).kind, 'skill');
  assert.deepEqual(fns.chatSkillLookup('other:today', lists), { kind: 'skill', label: 'other:today', desc: '', filePath: '' }, "another plugin's 'today' is not the AIOS command");
  assert.deepEqual(fns.chatSkillLookup('unknown', null), { kind: 'skill', label: 'unknown', desc: '', filePath: '' }, 'before the lists land');
});

test('the description under the line is its first sentence', () => {
  assert.equal(fns.chatSkillBrief('Use before creative work. Then more.'), 'Use before creative work.');
  assert.equal(fns.chatSkillBrief('No full stop here'), 'No full stop here');
  assert.equal(fns.chatSkillBrief('v1.2 rules apply. Next.'), 'v1.2 rules apply.', 'a dot inside a word does not end it');
  assert.ok(fns.chatSkillBrief('x'.repeat(400)).length <= 160);
});

test('wiring: every tool row is painted as a skill line or not, and a skill line never folds', () => {
  assert.match(app, /chatSkinPaintTool\(rec, item\);\n    chatSkinSkillPaint\(rec\);/);
  assert.match(app, /!n\.classList\.contains\('skill-line'\) && !!n\.csRec/);
  assert.match(fs.readFileSync('renderer/theme.css', 'utf8'), /\.tab\.dropok \{/, 'a tab a file is held over is lit');
});

test('review: lines painted before the lists landed are painted again, and a failed read is asked again', () => {
  const load = grab('chatSkillListsGet');
  assert.match(load, /rec\.role === 'tool' && rec\.node\.classList\.contains\('skill-line'\)\) \{[^\n]*\n\s*chatSkinSkillPaint\(rec\);/, 'every skill line, not only those that already had a description bar');
  assert.doesNotMatch(load, /if \(rec\.skillBar\) chatSkinSkillPaint/, 'negative control: the old filter missed lines painted with no bar');
  assert.match(load, /\.catch\(\(\) => \{ chatSkillListsLoad = null; \}\)/, 'a failed read is not cached');
  assert.match(load, /chatSkillListsStale = true; chatSkillListsLoad = null;/, 'a re-read marks the lists stale, never empties them (second review: lines flickered)');
  assert.doesNotMatch(load, /chatSkillLists = null;/, 'negative control: emptying the lists dropped every description for a moment');
  assert.match(load, /if \(rec\.tool\.argFresh\) \{ rec\.tool\.argFresh = false; chatLinkPaths\(/, 'the repaint links the rewritten label itself');
});
