/**
 * One vault on several computers: USER.md's Identity table keeps one row per computer's primary
 * session, and each computer picks its own. The choice is MACHINE-LOCAL (~/.aios/app.json), never the
 * synced framework, or the laptop's choice would follow the vault to the agent machine.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { identityRowsIn, choosePrimaryIdentity } from '../core/primaryIdentity';

const USER_MD = [
  '# USER', '', '## Identity', '', '> Named sessions.', '',
  '| Name | Role | Greeting style |', '|------|------|----------------|',
  '| `laptop-main` | Laptop primary | Warm. |', '| `agent-box` | Agent machine | Brief. |', '', '## Settings', '', '| Name | Role |', '| `not-me` | x |',
].join('\n');

test('the Identity rows come back in table order, names as written, each with its role, and the table ends at the next section', () => {
  assert.deepEqual(identityRowsIn(USER_MD), [{ name: 'laptop-main', role: 'Laptop primary' }, { name: 'agent-box', role: 'Agent machine' }]);
  const byHeader = USER_MD.replace('## Identity', '## Who runs here');
  assert.deepEqual(identityRowsIn(byHeader).map((r) => r.name), ['laptop-main', 'agent-box'], 'found by its header row when the heading is renamed');
  assert.deepEqual(identityRowsIn('# nothing here'), []);
  assert.deepEqual(identityRowsIn('## Identity\n\n| Name | Style |\n|---|---|\n| `solo` | warm |\n').map((r) => r.name), ['solo'], 'a header without a Role column is still the header, never a name');
});

test('this computer\'s choice wins; none means the first row; a choice no longer in the table falls back to the first and says so', () => {
  const rows = identityRowsIn(USER_MD);
  assert.deepEqual(choosePrimaryIdentity(rows, ''), { name: 'laptop-main', stale: false });
  assert.deepEqual(choosePrimaryIdentity(rows, 'agent-box'), { name: 'agent-box', stale: false });
  assert.deepEqual(choosePrimaryIdentity(rows, 'AGENT-BOX'), { name: 'agent-box', stale: false }, 'case does not matter; the name as written comes back');
  assert.deepEqual(choosePrimaryIdentity(rows, 'gone'), { name: 'laptop-main', stale: true });
  assert.deepEqual(choosePrimaryIdentity([], 'agent-box'), { name: '', stale: false });
  /* Control: the old rule (always the first row) launches the wrong identity on the second computer. */
  const firstRow = (r: typeof rows): string => r[0].name;
  assert.notEqual(firstRow(rows), choosePrimaryIdentity(rows, 'agent-box').name, 'control: first-row-always is the bug this fixes');
});

test('the choice is stored in ~/.aios/app.json (machine-local), not in the framework\'s .glass/shell.json, and the Launch name follows it', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-ident-home-'));
  const fw = fs.mkdtempSync(path.join(os.tmpdir(), 'aios-ident-fw-'));
  fs.writeFileSync(path.join(fw, 'USER.md'), USER_MD);
  fs.mkdirSync(path.join(fw, '.glass'), { recursive: true });
  fs.writeFileSync(path.join(fw, '.glass', 'shell.json'), '{}\n');
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, FW: process.env.GLASS_FRAMEWORK_PATH };
  process.env.HOME = home; process.env.USERPROFILE = home; process.env.GLASS_FRAMEWORK_PATH = fw;
  try {
    const aios = await import('../main/aios');
    assert.equal(aios.primaryName(), 'laptop-main', 'no choice yet: the first row, as before');
    assert.equal(aios.setPrimaryIdentity('agent-box').ok, true);
    assert.equal(aios.primaryName(), 'agent-box', 'the Launch button and every "launch the primary" path read this');
    const app = JSON.parse(fs.readFileSync(path.join(home, '.aios', 'app.json'), 'utf8'));
    assert.equal(app.primaryIdentity, 'agent-box', 'stored machine-locally');
    assert.equal(fs.readFileSync(path.join(fw, '.glass', 'shell.json'), 'utf8'), '{}\n', 'the synced framework is untouched');
    assert.equal(aios.setPrimaryIdentity('nobody').ok, false, 'only a name from the table is stored');
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.aios', 'app.json'), 'utf8')).primaryIdentity, 'agent-box', 'a refused value changes nothing');
    fs.writeFileSync(path.join(fw, 'USER.md'), USER_MD.replace('| `agent-box` | Agent machine | Brief. |\n', ''));
    const st = aios.primaryIdentitySetting();
    assert.equal(st.name, 'laptop-main');
    assert.equal(st.stale, true, 'Settings is told the stored name went away');
  } finally {
    process.env.HOME = saved.HOME; process.env.USERPROFILE = saved.USERPROFILE;
    if (saved.FW === undefined) delete process.env.GLASS_FRAMEWORK_PATH; else process.env.GLASS_FRAMEWORK_PATH = saved.FW;
  }
});

test('Settings shows the picker only with two or more identities, in place of the single-name rename field', () => {
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  assert.match(app, /const many = !!\(st && Array\.isArray\(st\.rows\) && st\.rows\.length >= 2\);\s*identRow\.hidden = !many;\s*primRow\.hidden = many;/);
  assert.match(app, /await window\.glassShell\.setPrimaryIdentity\(identSel\.value\)/);
  for (const l of ['en', 'es', 'pt-br', 'el']) {
    const j = JSON.parse(fs.readFileSync(`src/i18n/locales/${l}.json`, 'utf8')) as Record<string, string>;
    for (const k of ['settings.primaryIdentity', 'settings.primaryIdentityHint', 'settings.primaryIdentityStale']) assert.ok(j[k], `${l}: ${k}`);
    assert.match(j['settings.primaryIdentityStale'], /\{stored\}[\s\S]*\{name\}/, `${l}: both placeholders`);
  }
});
