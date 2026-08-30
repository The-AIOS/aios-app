import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  parseManifest, substitute, classify, driftReasons, pendingKeys,
  liveEntry, registeredNames, normaliseId,
  sniffCustom, slugFromHost, slugFromPkg, sanitiseId, unsubstituted,
  type ConnectorDef,
} from '../core/connectors';
import { listConnectors, unmanifested, addArgv, manifests as mainManifests } from '../main/connectors';

const ok = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'demo', service: 'Demo', value: 'v', connect: 'one-click',
  register: { transport: 'stdio', command: 'npx', args: ['-y', 'demo'] }, ...over,
});
const def = (over: Partial<ConnectorDef> = {}): ConnectorDef => ({
  id: 'demo', service: 'Demo', value: 'v', infrastructure: false, registers: true,
  connect: 'one-click', requires: [], ...over,
});
const always = () => true;
const never = () => false;

/* ── the manifest is the only source ───────────────────────────────────────── */

test('B2a — the App source ships no connector list', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/core/connectors.ts'), 'utf8');
  // A table would have to name services. If any bundled service name appears as a string
  // literal here, knowledge got copied out of canonical and will drift.
  for (const service of ['Google Workspace', 'Jira', 'NotebookLM', 'Spotify']) {
    assert.ok(!new RegExp(`['"\`]${service}`).test(src), `"${service}" is hardcoded — read it from the manifest`);
  }
  assert.ok(!/export const CONNECTORS/.test(src), 'a CONNECTORS table is exactly the third copy the contract forbids');
});

test('a malformed manifest drops the connector rather than half-rendering it', () => {
  assert.equal(parseManifest(null), null);
  assert.equal(parseManifest('nope'), null);
  assert.equal(parseManifest({ service: 'No id' }), null);
  assert.equal(parseManifest({ id: 'x' }), null, 'no service means nothing to show the operator');
});

test('an unregisterable register block is dropped, not kept half-built', () => {
  assert.equal(parseManifest(ok({ register: { transport: 'stdio' } }))!.register, undefined);
  assert.equal(parseManifest(ok({ register: { transport: 'http' } }))!.register, undefined);
  assert.equal(parseManifest(ok({ register: { transport: 'http', url: 'https://x/mcp' } }))!.register!.url, 'https://x/mcp');
});

test('connect defaults to guided — the mode that promises least', () => {
  assert.equal(parseManifest(ok({ connect: 'nonsense' }))!.connect, 'guided');
  assert.equal(parseManifest(ok({ connect: undefined }))!.connect, 'guided');
  assert.equal(parseManifest(ok({ connect: 'one-click' }))!.connect, 'one-click');
});

/* ── {framework}, the symlink defect ──────────────────────────────────────── */

test('{framework} is substituted everywhere a path can hide', () => {
  const d = parseManifest(ok({
    requires: ['{framework}/mcps/x-mcp/.venv/bin/python'],
    register: {
      transport: 'stdio', command: '{framework}/mcps/x-mcp/.venv/bin/python',
      args: ['{framework}/mcps/x-mcp/server.py'], env: { DIR: '{framework}/creds' },
    },
  }))!;
  const s = substitute(d, '/real/root', '/Users/me');
  assert.equal(s.requires[0], '/real/root/mcps/x-mcp/.venv/bin/python');
  assert.equal(s.register!.command, '/real/root/mcps/x-mcp/.venv/bin/python');
  assert.equal(s.register!.args![0], '/real/root/mcps/x-mcp/server.py');
  assert.equal(s.register!.env!.DIR, '/real/root/creds');
});

test('substitute survives a def with no register block', () => {
  assert.doesNotThrow(() => substitute(def({ requires: ['{framework}/a'] }), '/r', '/h'));
});

/* ── the five states ──────────────────────────────────────────────────────── */

test('unregistered, nothing missing → available', () => {
  assert.equal(classify(def(), undefined, always).state, 'available');
});

test('needs-install wins over everything, INCLUDING a live registration', () => {
  // The whole point: a registered connector whose interpreter was never built is broken, and
  // calling it "connected" is the lie AI-122 exists to remove.
  const d = def({ requires: ['/nope/.venv/bin/python'] });
  assert.equal(classify(d, undefined, never).state, 'needs-install');
  const live = { command: '/nope/.venv/bin/python', args: [] };
  assert.equal(classify(d, live, never).state, 'needs-install');
});

test('registered but the operator key is still a placeholder → needs-key', () => {
  const d = def({ register: { transport: 'stdio', command: 'uvx', args: ['x'], env: { TOKEN: '{ask:token}' } } });
  assert.equal(classify(d, { command: 'uvx', args: ['x'], env: {} }, always).state, 'needs-key');
  assert.equal(classify(d, { command: 'uvx', args: ['x'], env: { TOKEN: '{ask:token}' } }, always).state, 'needs-key');
  assert.equal(classify(d, { command: 'uvx', args: ['x'], env: { TOKEN: 'real' } }, always).state, 'connected');
});

test('drift — the live registration carrying args the manifest excludes', () => {
  // The real case: one bundled connector runs with two permissions its own index calls
  // "intentionally excluded", and no surface reports it. This is that surface.
  const d = def({ register: { transport: 'stdio', command: 'uvx', args: ['workspace-mcp', 'calendar:full'] } });
  const live = { command: 'uvx', args: ['workspace-mcp', 'calendar:full', 'chat:full', 'appscript:full'] };
  const r = classify(d, live, always);
  assert.equal(r.state, 'drift');
  assert.match(r.detail.join(' '), /extra: chat:full appscript:full/);
});

test('drift detail names what is missing, and never an env VALUE', () => {
  const d = def({ register: { transport: 'stdio', command: 'uvx', args: ['a', 'b'], env: { SECRET_TOKEN: 'x' } } });
  const detail = driftReasons(d, { command: 'uvx', args: ['a'], env: {} }).join(' ');
  assert.match(detail, /missing: b/);
  assert.match(detail, /no SECRET_TOKEN/);
  assert.ok(!detail.includes('x'), 'env values are secrets and must never reach the UI');
});

test('same args in a different order is still drift, and says so plainly', () => {
  const d = def({ register: { transport: 'stdio', command: 'n', args: ['a', 'b'] } });
  assert.match(driftReasons(d, { command: 'n', args: ['b', 'a'] }).join(' '), /different order/);
});

test('http drift compares the endpoint', () => {
  const d = def({ register: { transport: 'http', url: 'https://mcp.mint.gg/mcp' } });
  assert.equal(driftReasons(d, { url: 'https://mcp.mint.gg/mcp' }).length, 0);
  assert.match(driftReasons(d, { url: 'https://evil/mcp' }).join(' '), /endpoint is https:\/\/evil\/mcp/);
});

test('a connector with no register block never reports drift', () => {
  assert.deepEqual(driftReasons(def(), { command: 'anything' }), []);
});

test('pendingKeys ignores env the manifest supplies itself', () => {
  const d = def({ register: { transport: 'stdio', command: 'x', env: { MODE: 'true', TOKEN: '{ask:t}' } } });
  assert.deepEqual(pendingKeys(d, { env: {} }), ['TOKEN']);
});

/* ── reading the live file ────────────────────────────────────────────────── */

test('per-project registrations are found — where 14 of 16 actually live', () => {
  const cj = {
    mcpServers: { railway: { command: 'railway' } },
    projects: { '/Users/x/obsidian': { mcpServers: { slack: { command: 'npx' } } } },
  };
  assert.equal(liveEntry(cj, 'railway')!.command, 'railway');
  assert.equal(liveEntry(cj, 'slack')!.command, 'npx');
  assert.equal(liveEntry(cj, 'absent'), undefined);
  assert.deepEqual([...registeredNames(cj)].sort(), ['railway', 'slack']);
});

test('the -mcp suffix does not decide whether a connector is connected', () => {
  assert.equal(normaliseId('slack-mcp'), 'slack');
  const cj = { mcpServers: { 'slack-mcp': { command: 'npx' } } };
  assert.ok(liveEntry(cj, 'slack'), 'folder id slack must match registry name slack-mcp');
});

test('a malformed claude.json is empty, not an exception', () => {
  for (const bad of [null, undefined, 'str', 42, { projects: null }, { mcpServers: 'x' }]) {
    assert.doesNotThrow(() => registeredNames(bad));
    assert.doesNotThrow(() => liveEntry(bad, 'slack'));
  }
});

/* ── B3: the word ─────────────────────────────────────────────────────────── */

test('B3 — no manifest on disk may name the protocol at the operator', () => {
  const root = frameworkRootForTest();
  if (!root) return; // framework not beside the checkout (CI) — the disk claim is unverifiable here
  let checked = 0;
  for (const m of manifestsOnDisk(root)) {
    const d = parseManifest(JSON.parse(fs.readFileSync(m, 'utf8')), path.basename(path.dirname(m)));
    assert.ok(d, `${m} does not parse`);
    assert.doesNotMatch(d!.service, /\bMCPs?\b/i, `${m}: service names the protocol`);
    for (const p of [...d!.requires, ...(d!.register?.args ?? []), d!.register?.command ?? ''])
      assert.ok(!/(^|\/)\.?~?\/?aios\/mcps\//.test(p) || p.includes('{framework}'),
        `${m}: hardcodes a framework path instead of {framework} — the symlink defect`);
    checked++;
  }
  console.log(`    checked ${checked} manifest(s) on disk`);
});

test('B3 — and that guard fails when the defect is present', () => {
  let caught = false;
  try { assert.doesNotMatch('Slack MCP', /\bMCPs?\b/i); } catch { caught = true; }
  assert.ok(caught, 'the pattern must reject "Slack MCP" — otherwise it measures nothing');
});

function frameworkRootForTest(): string | undefined {
  for (const c of [process.env.GLASS_FRAMEWORK_PATH, path.join(process.env.HOME || '', 'aios')]) {
    if (c && fs.existsSync(path.join(c, 'mcps'))) return fs.realpathSync(c);
  }
  return undefined;
}
function manifestsOnDisk(root: string): string[] {
  const dir = path.join(root, 'mcps');
  return fs.readdirSync(dir)
    .map((d) => path.join(dir, d, 'connector.json'))
    .filter((p) => fs.existsSync(p));
}

/* ── add-custom ───────────────────────────────────────────────────────────── */

test('sniffCustom takes an http endpoint and an npm package, and nothing it must guess at', () => {
  assert.deepEqual(sniffCustom('https://mcp.mint.gg/mcp'), { kind: 'http', url: 'https://mcp.mint.gg/mcp', id: 'mint' });
  assert.deepEqual(sniffCustom('@vendor/mcp-thing'), { kind: 'npm', pkg: '@vendor/mcp-thing', id: 'thing' });
  for (const local of ['/Users/x/code/my-mcp', '~/code/my-mcp', './rel', 'C:\\mcp',
                       'https://github.com/org/repo', 'https://gitlab.com/org/repo']) {
    assert.equal(sniffCustom(local).kind, 'unsupported', `${local} must not be guessed at`);
    assert.equal((sniffCustom(local) as { reason: string }).reason, 'local');
  }
  for (const junk of ['', '   ', 'what is an mcp', 'http://']) {
    assert.equal(sniffCustom(junk).kind, 'unsupported');
  }
});

test('slugFromPkg strips the plumbing repeatedly, and terminates', () => {
  for (const [pkg, want] of [
    ['mcp-server-foo', 'foo'],
    ['@modelcontextprotocol/server-filesystem', 'filesystem'],
    ['@vendor/mcp-thing', 'thing'],
    ['slack-mcp', 'slack'],
  ] as const) assert.equal(slugFromPkg(pkg), want, pkg);

  // The strip loop is bounded at 4 passes so a pathological name terminates instead of looping.
  // It is allowed to give up mid-strip; it is NOT allowed to hang or to return an unsafe id.
  const pathological = slugFromPkg('mcp-'.repeat(40) + 'x');
  assert.match(pathological, /^[a-z0-9-]+$/, 'must still be a safe id');
  assert.ok(pathological.length < 200);
});

test('slugFromHost keeps the service, not the host', () => {
  assert.equal(slugFromHost('mcp.mint.gg'), 'mint');
  assert.equal(slugFromHost('api.example.com'), 'example');
});

test('sanitiseId defeats traversal and substitution — these ids reach a shell and a mkdir', () => {
  assert.equal(sanitiseId('../../etc/passwd'), 'etc-passwd');
  assert.equal(sanitiseId('a; rm -rf /'), 'a-rm-rf');
  assert.equal(sanitiseId('$(whoami)'), 'whoami');
  assert.equal(sanitiseId('...'), 'connector');
  assert.equal(sanitiseId(''), 'connector');
});

/* ── the card, and the guards that hold it ────────────────────────────────── */

const APP = (): string => fs.readFileSync(path.join(__dirname, '../../renderer/app.js'), 'utf8');

/**
 * Source with comments removed.
 *
 * Six times in one day a source-grep guard in this file failed on the comment EXPLAINING the very
 * defect it guards — prompt(), repairCmd, the phase1 OS guard, fsRoots, innerHTML, and a bundle
 * probe that read a fix's own description as the defect. Each time the tempting "fix" is to delete
 * the explanation, which keeps the guard green and removes the reason anyone would understand it.
 * So the stripping lives here once, and every text guard uses it.
 */
const noComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
const LOC = (l: string): Record<string, string> =>
  JSON.parse(fs.readFileSync(path.join(__dirname, `../../src/i18n/locales/${l}.json`), 'utf8'));
const LOCALES = ['en', 'es', 'pt-br'];

test('B3 — no operator-visible string names the protocol, in any locale', () => {
  for (const l of LOCALES) {
    for (const [k, v] of Object.entries(LOC(l))) {
      assert.doesNotMatch(String(v), /\bMCPs?\b/i, `${l}: ${k} = ${v}`);
    }
  }
});

test('B3 — and that sweep fails when the defect is reintroduced', () => {
  // Guards that read intent can be talked out of firing. This one is mutated so the defect is
  // actually present, and the red line is required.
  let caught = false;
  try { assert.doesNotMatch('Obsidian MCP', /\bMCPs?\b/i); } catch { caught = true; }
  assert.ok(caught, 'the sweep above measures nothing if this pattern accepts "Obsidian MCP"');
});

test('every connector string exists in all three locales — a missing key renders as its own name', () => {
  const keys = Object.keys(LOC('en')).filter((k) => k.startsWith('conn.') || k === 'pulse.connectors');
  assert.ok(keys.length >= 18, `expected the full connector vocabulary, found ${keys.length}`);
  for (const l of LOCALES) {
    const d = LOC(l);
    for (const k of keys) assert.ok(d[k] && String(d[k]).trim(), `${l} is missing ${k}`);
  }
});

test('the card is registered as a card — container, icon, and the Settings toggle', () => {
  const app = APP();
  const html = fs.readFileSync(path.join(__dirname, '../../renderer/index.html'), 'utf8');
  assert.match(html, /id="pConnectors"/, 'no container means refreshConnectors silently no-ops');
  assert.match(app, /pConnectors: 'plug'/, 'a card with no icon falls back to a star');
  assert.match(app, /\['pConnectors', 'pulse\.connectors'\]/, 'not in CARDS → cannot be hidden in Settings');
});

test('the card never calls prompt() — Electron does not implement it', () => {
  // It logs "prompt() is and will not be supported" and returns undefined, so an add flow built on
  // it looks wired and does nothing, on every platform.
  //
  // Comments are stripped first. Without that, this guard failed on the comment EXPLAINING why
  // prompt() is not used — a guard that fires on its own documentation would have been "fixed" by
  // deleting the explanation, leaving the real defect uncovered.
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const block = APP().split('CONNECTORS — the services')[1] ?? '';
  assert.ok(block, 'connectors block not found — this guard has stopped measuring anything');
  const code = strip(block.split('Registry status')[0]);
  const CALL = /(^|[^.\w])prompt\s*\(/;
  assert.doesNotMatch(code, CALL, 'use the inline input, not window.prompt');

  // …and the pattern still catches a real call, so passing means something.
  assert.match(strip('const x = prompt("hi");'), CALL);
  assert.doesNotMatch(strip('/* window.prompt() is unsupported */'), CALL);
});

test('the handover prompt no longer claims the first ritual — the interview owns it', () => {
  const app = APP();
  assert.match(app, /Set up my AI-OS from https:\/\/github\.com\/The-AIOS\/aios/, 'handover prompt moved');
  assert.doesNotMatch(app, /finish by running \/aios:today/,
    'Front A made the interview the only thing that runs the first /aios:today');
});

test('the theme carries the third dot grade and the input the card renders', () => {
  const css = fs.readFileSync(path.join(__dirname, '../../renderer/theme.css'), 'utf8');
  assert.match(css, /\.phdot\.st-mute/, 'available/needs-install rows would render as healthy green');
  assert.match(css, /\.phsect/, 'the "other connections" heading would inherit no styling');
  // Theme-aware by token, never a pinned hex — the card renders in both themes.
  const rule = css.slice(css.indexOf('.phdot.st-mute'), css.indexOf('.phdot.st-mute') + 120);
  assert.doesNotMatch(rule, /#[0-9a-f]{3,6}/i, 'pinned colour breaks one of the two themes');
});

test('B4 — the handoff copy sets all three expectations the audit named', () => {
  // Friction #3 was the unannounced drop into a terminal. The fix is copy that says what is about
  // to happen: a conversation, in plain words, with nothing to install by hand, and how long.
  for (const l of LOCALES) {
    const s = String(LOC(l)['onboarding.sub.firstrun'] ?? '');
    assert.ok(s, `${l}: no handoff copy`);
    assert.match(s, /conversa|conversac|conversation/i, `${l}: does not say it is a conversation`);
    assert.match(s, /hand|mano|à mão/i, `${l}: does not say nothing needs installing by hand`);
    assert.match(s, /five|cinco/i, `${l}: does not say how long the short version is`);
  }
});

test('an infrastructure manifest never reports drift, listed or not', () => {
  // Canonical's manifests mark three folders infrastructure:true for two DIFFERENT reasons:
  // obsidian is a real server that happens to be plumbing (disconnecting it breaks vault editing);
  // notebooklm and playwright are not servers at all (no server code — they deliver through a
  // bundled skill and through direct Python). Both reasons mean "never offer this as a service",
  // and the card must not read their absent registration as a problem to fix.
  const root = frameworkRootForTest();
  if (!root) return;
  const infra = manifestsOnDisk(root)
    .map((m) => ({ m, d: parseManifest(JSON.parse(fs.readFileSync(m, 'utf8')), '') }))
    .filter((x) => x.d?.infrastructure);
  if (!infra.length) return;
  for (const { m, d } of infra) {
    // Not registered + infrastructure must never surface as drift or needs-install.
    const c = classify(substitute(d!, root), undefined, () => false);
    assert.ok(c.state !== 'drift', `${m}: infrastructure reported as drift`);
  }
  console.log(`    ${infra.length} infrastructure manifest(s) excluded`);
});

test('only a real server acting as plumbing is hidden — a non-server stays visible', () => {
  /* The filter was `!d.infrastructure`, which hid BOTH obsidian (a real server that is plumbing)
     and notebooklm/playwright (not servers at all) — and that made the `provided` state
     unreachable, so a state, a button, three strings and a test existed for something that could
     never render. Found by the operator asking why NotebookLM was missing from his card.
     `registers` is a fact about the thing; `infrastructure` is a presentation choice. Fact wins. */
  const src = fs.readFileSync(path.join(__dirname, '../../src/main/connectors.ts'), 'utf8');
  assert.match(src, /\.filter\(\(d\) => !\(d\.infrastructure && d\.registers\)\)/,
    'the render filter must distinguish plumbing from not-a-server');
  assert.doesNotMatch(src, /\.filter\(\(d\) => !d\.infrastructure\)/, 'the collapsing filter is back');

  // And the rule, exercised rather than grepped.
  const hidden = (d: ConnectorDef) => d.infrastructure && d.registers;
  assert.equal(hidden(def({ infrastructure: true, registers: true })), true, 'obsidian: plumbing → hidden');
  assert.equal(hidden(def({ infrastructure: true, registers: false })), false, 'notebooklm: not a server → shown');
  assert.equal(hidden(def({ infrastructure: false, registers: true })), false, 'an ordinary connector → shown');
});

test('the provided state is REACHABLE against the real manifests', () => {
  // The guard that would have caught the dead code: a state nothing can enter is not a state.
  const root = frameworkRootForTest();
  if (!root) return;
  const rows = listConnectors(root).rows;
  const provided = rows.filter((r) => r.state === 'provided');
  assert.ok(provided.length > 0,
    'no manifest can reach `provided` — either the filter hides them again or registers:false is gone');
  for (const r of provided) {
    assert.ok(r.detail.length === 0, 'a non-server has nothing missing');
    assert.equal(r.canConnect, false, 'nothing to connect — it must not offer one');
  }
  console.log(`    provided rows: ${provided.map((r) => r.service).join(', ')}`);
});

/* ── registers:false — a folder that is not a server at all ───────────────── */

test('registers:false is parsed, and defaults true so an ordinary manifest says nothing', () => {
  assert.equal(parseManifest(ok())!.registers, true, 'silence must mean "ordinary connector"');
  assert.equal(parseManifest(ok({ registers: false }))!.registers, false);
  assert.equal(parseManifest(ok({ registers: 'no' }))!.registers, true, 'only an explicit false counts');
});

test('a non-server reports provided — never available, never drift', () => {
  // notebooklm and playwright ship no server code: notebooklm delivers through the bundled skill,
  // playwright as a Python toolkit invoked directly. Offering Connect would register a command
  // pointing at a server that does not exist — inventing the failure this ticket removes.
  const d = def({ registers: false, register: undefined });
  assert.equal(classify(d, undefined, always).state, 'provided');
  // Even with a stray live entry, it must not be judged against a registration it cannot have.
  assert.equal(driftReasons(def({ registers: false, register: { transport: 'stdio', command: 'x', args: ['a'] } }),
    { command: 'y', args: ['b'] }).length, 0, 'a non-server cannot drift');
});

test('the guard fails if registers is ignored — which is how I shipped it the first time', () => {
  // I told canonical to keep `registers: false` while my reader ignored the field entirely. The
  // mutation: a reader that drops `registers` classifies a non-server as connectable.
  const asIfIgnored = { ...def({ registers: false }), registers: true };
  assert.notEqual(classify(asIfIgnored, undefined, always).state, 'provided',
    'if this were still provided, the test above would pass for the wrong reason');
});

test('an unmanifested bundled folder is reported, not silently swallowed', () => {
  // The C1 distinction: "missing manifest → not listed" gives the right OUTCOME but the same one
  // as infrastructure:true, so alone it cannot tell "deliberately not a service" from "nobody
  // wrote the manifest yet".
  const root = frameworkRootForTest();
  if (!root) return;
  const described = new Set(
    manifestsOnDisk(root)
      .map((m) => parseManifest(JSON.parse(fs.readFileSync(m, 'utf8')), ''))
      .filter(Boolean).map((d) => normaliseId(d!.id)),
  );
  const gaps = unmanifested(root, described);
  // Only `-mcp` folders count, so a company namespace or `custom/` itself is never a false alarm.
  for (const g of gaps) assert.match(g.id, /^[a-z0-9-]+$/);
  console.log(`    unmanifested folders: ${gaps.length ? gaps.map((g) => g.id).join(', ') : 'none'}`);
});

test('unmanifested never double-reports as foreign', () => {
  const root = frameworkRootForTest();
  if (!root) return;
  const { foreign, unmanifested: gaps } = listConnectors(root);
  const f = new Set(foreign.map((x) => x.id));
  for (const g of gaps) assert.ok(!f.has(g.id), `${g.id} reported as both unknown and unmanifested`);
});

test('all three locales carry the two new state words', () => {
  for (const l of LOCALES) {
    const d = LOC(l);
    for (const k of ['conn.provided', 'conn.providedHint', 'conn.other', 'conn.driftPlain', 'conn.fix',
                     'conn.handing', 'conn.guidedHint', 'conn.secBundled', 'conn.secCustom', 'conn.noCustom']) {
      assert.ok(d[k] && String(d[k]).trim(), `${l} is missing ${k}`);
      assert.doesNotMatch(String(d[k]), /\bMCPs?\b/i, `${l}: ${k} names the protocol`);
    }
  }
});

/* ── B1: no check may offer another platform's command ────────────────────── */

test('B1 — the renderer never fabricates an install command', () => {
  // It read repairCmd with a string-literal fallback, and repairCmd was undefined on Linux — so a
  // Linux operator missing git was offered a macOS command, on a platform we publish (.deb and
  // AppImage are both release assets). A renderer fallback can only guess; the check knows its OS.
  //
  // Comments are stripped first: without that this fired on the comment DOCUMENTING the fix, which
  // would have been "fixed" by deleting the explanation and leaving the defect uncovered. Second
  // time that shape appeared in this file, so it is a pattern, not an accident.
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const code = strip(APP());
  assert.doesNotMatch(code, /repairCmd\s*\|\|\s*['"]/,
    'a string-literal fallback for repairCmd is a command invented by the renderer');
  assert.doesNotMatch(code, /fixPane\([^)]*\|\|\s*['"]/, 'same defect, any check');
});

test('B1 — and that guard fails on the exact line it was written for', () => {
  const PAT = /repairCmd\s*\|\|\s*['"]/;
  assert.match("fixPane('git', git.repairCmd || 'xcode-select --install')", PAT,
    'the pattern must catch the original line — otherwise the guard above measures nothing');
  assert.doesNotMatch("fixPane('git', git.repairCmd)", PAT);
});

test('B1 — git and node both carry a remedy on every platform we publish', () => {
  // .deb, .AppImage, .dmg and .exe all ship, so "every platform" includes Linux.
  const src = fs.readFileSync(path.join(__dirname, '../../src/main/aios.ts'), 'utf8');
  for (const fn of ['installGitCmd', 'installNodeCmd']) {
    const i = src.indexOf(`function ${fn}(`);
    assert.ok(i > 0, `${fn} is gone`);
    const body = src.slice(i, src.indexOf('\n}', i));
    assert.match(body, /darwin/, `${fn}: no macOS branch`);
    assert.match(body, /win32/, `${fn}: no Windows branch`);
    // The Linux branch is the fallthrough return — it must not be `undefined`.
    assert.doesNotMatch(body, /return undefined;?\s*$/, `${fn}: Linux still falls through to nothing`);
    assert.match(body, /apt-get|dnf|pacman/, `${fn}: no Linux package manager handled`);
  }
});

test('B1 — the Linux lines detect a package manager instead of assuming one', () => {
  // The .deb implies apt; the AppImage implies nothing. Assuming apt would fail silently on Fedora
  // or Arch, which is the same class of wrong instruction as the macOS command it replaced.
  const src = fs.readFileSync(path.join(__dirname, '../../src/main/aios.ts'), 'utf8');
  for (const fn of ['installGitCmd', 'installNodeCmd']) {
    const i = src.indexOf(`function ${fn}(`);
    const body = src.slice(i, src.indexOf('\n}', i));
    assert.match(body, /command -v apt-get/, `${fn}: does not probe before using apt`);
    assert.match(body, /else echo/, `${fn}: no plain-language answer when nothing is recognised`);
  }
});

/* ── the card's layout, and the dot that lied ─────────────────────────────── */

const CSS = (): string => fs.readFileSync(path.join(__dirname, '../../renderer/theme.css'), 'utf8');

test('a state dot beats .phdot by specificity, not by source order', () => {
  // `.st-warn` and `.phdot` are both one class, and .phdot is declared ~630 lines later, so it won
  // and every amber/red dot rendered green — in the Health card and the Setup steps too, where a
  // FAILING check therefore showed a healthy dot. Qualifying makes them 0,2,0.
  const css = CSS();
  for (const st of ['st-ok', 'st-warn', 'st-error', 'st-mute']) {
    assert.match(css, new RegExp(`\\.phdot\\.${st}\\s*\\{`), `.phdot.${st} is missing — that dot renders green`);
  }
  // The bare rules must still come BEFORE .phdot, which is what made qualifying necessary.
  assert.ok(css.indexOf('.st-warn {') < css.indexOf('.phdot {'),
    'if .st-warn ever moves after .phdot this guard stops describing the real hazard');
});

test('and the specificity claim is real, not assumed', () => {
  // Same class count → later declaration wins. Encoded so the reasoning is checkable rather than
  // asserted: if someone "simplifies" the qualified rules away, this explains what breaks.
  const css = CSS();
  const bare = css.indexOf('.st-warn { --sc:');
  const qualified = css.indexOf('.phdot.st-warn');
  assert.ok(bare >= 0 && qualified > bare, 'the qualified rule must come after the bare one to win');
});

test('a long service name truncates instead of pushing the button off the card', () => {
  // "Atlassian (Jira & Confluence)" clipped DISCONNECT in half. Labels come from manifests written
  // elsewhere, so the row must survive any length.
  const css = CSS();
  const lab = css.slice(css.indexOf('.phlab {'), css.indexOf('}', css.indexOf('.phlab {')));
  assert.doesNotMatch(lab, /flex:\s*0\s+0\s+auto/, 'a non-shrinking label overflows the card');
  assert.match(lab, /min-width:\s*0/, 'without min-width:0 a flex item never shrinks below its content');
  assert.match(lab, /text-overflow:\s*ellipsis/);
  const msg = css.slice(css.indexOf('.phmsg {'), css.indexOf('}', css.indexOf('.phmsg {')));
  assert.match(msg, /min-width:\s*0/);
});

test('a healthy row is one line; an exceptional one gets a second', () => {
  // Measured in a render harness at 260/300/360px — the widths a real pulse column has. Sharing
  // one line truncated the drift message at EVERY one of them ("differs from the fram…" even at
  // 360), so the row whose whole purpose is to explain itself could not. The second line also
  // gives the label its full width back, which fixed "Google…" in the same change.
  const app = APP();
  assert.match(app, /const exceptional = c\.state !== 'connected';/);
  assert.match(app, /r\.classList\.add\('two'\)/, 'the wrapping variant is what makes two lines possible');
  // The DETAIL must reach the sub-line, not just a tooltip: "differs from the framework" says
  // something is wrong, "extra: chat:full appscript:full" says what to do about it.
  const iSub = app.indexOf("el('div', 'phsub'");
  assert.ok(iSub > 0, 'the sub-line is gone');
  // The detail is now assembled just above the element (plain-language for drift, raw otherwise),
  // so look back as well as forward rather than pinning a byte offset after the call.
  assert.match(app.slice(iSub - 900, iSub + 200), /c\.detail/, 'the actionable detail must be visible, not hovered');

  const css = CSS();
  assert.match(css, /\.phrow\.two\s*\{[^}]*flex-wrap:\s*wrap/, 'no wrap → the sub-line sits on line one');
  // .phrow has overflow:hidden to stop a long label escaping the card; the wrapping variant must
  // opt out or the second line is clipped away entirely.
  assert.match(css, /\.phrow\.two\s*\{[^}]*overflow:\s*visible/, 'overflow:hidden would clip the sub-line');
  assert.match(css, /\.phsub\s*\{[^}]*flex:\s*0\s+0\s+100%/, 'without a 100% basis it does not start a new line');
});

test('phase1 refuses to run its macOS steps on a non-Mac', () => {
  // We publish .deb and .AppImage, so a Linux operator can install the app and press the one
  // button it offers. Without this guard that button runs Xcode CLT + Homebrew and fails partway,
  // which reads as a broken product rather than an unautomated step.
  const sh = fs.readFileSync(path.join(__dirname, '../../scripts/setup/phase1-prerequisites.sh'), 'utf8');
  // Anchored on the SECTION MARKERS, not on prose: the guard's own comment names Xcode and
  // Homebrew to explain what it is guarding, so a prose search finds the comment and concludes the
  // guard comes last. Third time in this session a guard matched its own documentation.
  const guard = sh.indexOf('uname -s');
  assert.ok(guard > 0, 'no OS guard');
  assert.ok(guard < sh.indexOf('# \u2500\u2500 1. Xcode'), 'the guard must precede the macOS-only steps');
  assert.ok(guard < sh.indexOf('# \u2500\u2500 2. Homebrew'), 'the guard must precede Homebrew');
  // exit 0, not 1 — an unautomated step is not the operator's failure.
  const block = sh.slice(guard, sh.indexOf('# ── 0.', guard));
  assert.match(block, /exit 0/, 'a red error frames this wrongly for someone who did nothing wrong');
  assert.match(block, /apt-get|dnf|pacman/, 'the guard should name real commands, not just refuse');
});


/* ── the operator's card, not the maintainer's ────────────────────────────── */

test('no row says "differs from the framework" to an operator', () => {
  // That sentence describes OUR bookkeeping. What it means to them is that the connection grants
  // access nothing here uses — a security question they can answer — next to a button that fixes it.
  const app = APP();
  assert.match(app, /c\.state === 'drift'\s*$/m, 'drift must be its own branch, not lumped with connected');
  assert.match(app, /conn\.driftPlain/, 'drift must use the plain-language string');
  assert.match(app, /connectorsFix/, 'stating a problem without offering the fix is why it read as noise');
  for (const l of LOCALES) {
    assert.doesNotMatch(String(LOC(l)['conn.driftPlain']), /framework|framework/i,
      `${l}: driftPlain still talks about the framework`);
  }
});

test(':full is stripped — it is registration syntax, not a service name', () => {
  assert.match(APP(), /replace\(\/:full\\b\/g, ''\)/, 'chat:full is not a thing an operator recognises');
});

test('every orphan connection is its own row with a Disconnect', () => {
  // Two comma-lists with no controls ("Connected, not bundled" / "Not described yet") were the
  // rows that read as "I cannot delete" — they are ordinary registrations and the ones most likely
  // to be unwanted.
  const app = APP();
  assert.match(app, /for \(const o of other\)/, 'the orphans must render per-row, not as a list');
  const i = app.indexOf('for (const o of other)');
  assert.match(app.slice(i, i + 700), /connectorsDisconnect\(o\.id\)/, 'each orphan needs its own control');
  assert.doesNotMatch(app, /conn\.foreign|conn\.gap/, 'the two uninterpretable rows are gone');
});

test('a custom folder is ADOPTED into Custom, and never also listed as unknown', () => {
  /* Two passes on the same idea. First, the two orphan categories were merged because
     registered-but-unbundled and bundled-but-undocumented are OUR distinctions. Then the operator
     asked why `mint` sat with remote endpoints when it lives in `mcps/custom/` — and the answer was
     that ownership was still being decided by whether we had a manifest for it. It is decided by
     location. A folder that is also registered would otherwise appear twice, which is exactly how
     `mint` first rendered in both groups at once. */
  const src = fs.readFileSync(path.join(__dirname, '../../src/main/connectors.ts'), 'utf8');
  assert.match(src, /adopted\.add\(g\.id\)/, 'an adopted folder must be recorded');
  assert.match(src, /!adopted\.has\(n\)/, 'and excluded from the unknown list');
  assert.match(src, /orphanGaps/, 'only a BUNDLED folder with no manifest is still an orphan');
  assert.match(src, /unmanifested: gaps/, 'the full gap list stays in the payload for maintainers');

  // Exercised against the real vault: no id may appear in both places.
  const root = frameworkRootForTest();
  if (!root) return;
  const { rows, other } = listConnectors(root);
  const ids = new Set(rows.map((r) => normaliseId(r.id)));
  for (const o of other) assert.ok(!ids.has(normaliseId(o.id)), `${o.id} is in both a group and "other"`);
});

test('the connect brief carries what a session would otherwise guess', () => {
  const app = APP();
  const i = app.indexOf('async function connectSession');
  assert.ok(i > 0, 'connectSession is gone');
  const fn = app.slice(i, app.indexOf('\n}', i));
  assert.match(fn, /README/, 'the session must be pointed at the documentation');
  assert.match(fn, /c\.pending/, 'name the missing credential');
  assert.match(fn, /BEFORE you ask me for it/, 'explain first, ask second — that is the whole point');
  assert.match(fn, /claude mcp list/, 'the brief must end in verification, not in a claim');
  assert.match(fn, /Assume I do not know/, 'the reason we opened a conversation is that they do not');
  // A secret must never be interpolated into a terminal command line.
  assert.doesNotMatch(fn, /answers|token=|secret=/i, 'the session collects the value, not the brief');
});

test('a folder or repo is handed to a session, not refused', () => {
  // Those need clone + dependency build + a derived run command — the judgment case, and exactly
  // what mcps/setup.sh does for the bundled ones.
  const app = APP();
  const i = app.indexOf("res.error === 'local'");
  assert.ok(i > 0, 'the local branch is gone');
  const branch = app.slice(i, i + 1200);
  assert.match(branch, /spawnNamed\('add-connector'/, 'hand it over');
  assert.match(branch, /connector\.json/, 'the session must leave a manifest behind, like every other connector');
  assert.doesNotMatch(app, /conn\.addLocal/, 'the refusal string should be gone with the refusal');
});

test('Add uses the shared modal, and hangs off the group it adds to', () => {
  const app = APP();
  const i = app.indexOf('async function addCustomFlow');
  assert.ok(i > 0, 'addCustomFlow is gone');
  const fn = app.slice(i, app.indexOf('\n}\n', i));
  assert.match(fn, /inputModal\(t\('conn\.addTitle'\)/, 'same modal as marketplace/space/PAT');
  assert.doesNotMatch(fn, /el\('input'/, 'the bespoke inline input is gone');
  // It belongs on the Custom section's + control, the way Sessions/Terminals work.
  assert.match(app, /onClick: \(\) => void addCustomFlow\(\)/);
  assert.doesNotMatch(app, /connAddRow/, 'the bottom-of-card row is gone');
});

test('the three groups collapse like the Running card, with their own persistence', () => {
  const app = APP();
  assert.match(app, /function connSection\(/, 'no section primitive');
  assert.match(app, /localStorage\.setItem\('connCollapsed'/, 'collapse state must survive a restart');
  // Scoped to connSection's own body: slicing to end-of-file swept in runSection itself, which
  // legitimately mentions runCollapsed — a guard that fails on the thing it is comparing against.
  const i = app.indexOf('function connSection');
  const body = app.slice(i, app.indexOf('\n}\n', i));
  assert.doesNotMatch(body, /runCollapsed/,
    'sharing the Running card\'s set would collapse Sessions when you collapse Bundled');
  assert.match(body, /connCollapsed/, 'it needs its own set');
  for (const k of ["'bundled'", "'custom'", "'other'"]) assert.ok(app.includes(k), `missing group ${k}`);
  // `other` starts collapsed — longest group, looked at least often.
  assert.match(app, /getItem\('connCollapsed'\) \|\| '\["other"\]'/);
});

test('the card re-reads when the world changed behind its back', () => {
  /* It polled every five minutes and otherwise only on boot or the manual ↻ — so connecting
     something in a session, now the DEFAULT path for anything not one-click, left the card wrong
     until the operator found the refresh button. Reported exactly that way. */
  const app = APP();
  assert.match(app, /addEventListener\('focus', \(\) => void refreshConnectors\(\)\)/,
    'every path that changes a connector leaves this window; coming back is the signal');
  assert.match(app, /connect-\|add-connector.*refreshConnectors/s,
    'a closing guided session should not wait for focus');
});

test('fixDrift carries existing secrets across instead of re-asking', () => {
  // Making someone re-paste a client secret to tidy a permission list is worse than the drift.
  const src = fs.readFileSync(path.join(__dirname, '../../src/main/connectors.ts'), 'utf8');
  const i = src.indexOf('export async function fixDrift');
  const fn = src.slice(i, src.indexOf('\n}', i));
  assert.match(fn, /live\.env/, 'existing env values must be reused');
  assert.match(fn, /mcp', 'remove'/, 'add does not reliably replace an existing name');
  assert.doesNotMatch(fn, /inputModal|prompt/, 'main never asks the operator anything');
});

test('disconnect verifies against the file, and works without a manifest', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/main/connectors.ts'), 'utf8');
  const i = src.indexOf('export async function disconnect');
  const fn = src.slice(i, src.indexOf('\n}', i));
  assert.match(fn, /liveEntry\(readJson\(claudeJsonPath\(\)\)/, 'trust the file, not the exit code');
  assert.doesNotMatch(fn, /no-manifest/, 'an orphan registration must still be removable');
});

test('the tooltip carries the registry id — capability names hide the codename', () => {
  // Canonical names by capability: nano-banana is "Image generation", pdf-generator is "PDF
  // export". Right for someone who has never heard of either, invisible to an operator who knows
  // them by name and cannot find them in the card.
  const app = APP();
  const i = app.indexOf('const tip = [c.value');
  assert.ok(i > 0, 'the tooltip assembly moved');
  assert.match(app.slice(i, i + 250), /c\.id/, 'the id must be reachable without reading the manifest');
});

/* ── delete: the other half of "+ Add another" ────────────────────────────── */

test('delete is gated to mcps/custom/ — a bundled folder is canonical\'s, not ours', () => {
  // Removing a bundled folder would delete framework content that /aios:update restores on the
  // next sync, so the button would be a lie. Exercised live before shipping: deleting
  // google-workspace returned {ok:false,error:"bundled"} and the folder was intact.
  const src = fs.readFileSync(path.join(__dirname, '../../src/main/connectors.ts'), 'utf8');
  const i = src.indexOf('export async function deleteCustom');
  assert.ok(i > 0, 'deleteCustom is gone');
  const fn = src.slice(i, src.indexOf('\n}', i));
  // Distinguishes "yours, gone" from "not yours" — the operator gets a different answer for each.
  assert.match(fn, /'bundled'/, 'a bundled connector must be refused, and told apart from a missing one');
  assert.match(fn, /'not-found'/);
  /* The gate is WHERE the folder lives, not whether we have a manifest for it. That change came
     from a real row: mcps/custom/mint-mcp is the operator's own, predates the manifest convention,
     has only a README — and under the old manifest-based gate it was the one folder in the card
     with no way out. */
  assert.match(fn, /customFolder\(framework, id\)/, 'ownership is decided by folder location');
  assert.doesNotMatch(fn, /manifestDir\(framework, id\)\?\.custom/, 'a manifest is not what confers ownership');
});

test('delete resolves REAL paths before a recursive remove', () => {
  // This function ends in fs.rmSync({recursive:true}). That is not the place to trust an invariant
  // established three functions away, however sound it is.
  const src = fs.readFileSync(path.join(__dirname, '../../src/main/connectors.ts'), 'utf8');
  const i = src.indexOf('export async function deleteCustom');
  const fn = src.slice(i, src.indexOf('\n}', i));
  assert.match(fn, /realpathSync/, 'containment must be checked on resolved paths, not built strings');
  assert.match(fn, /startsWith\(root \+ path\.sep\)/, 'prefix match alone lets mcps/custom-evil through');
  assert.match(fn, /real === root/, 'the custom/ root itself must never be the delete target');
  assert.ok(fn.indexOf('realpathSync') < fn.indexOf('rmSync'), 'check before deleting, not after');
});

test('delete unregisters BEFORE removing the folder, and verifies both', () => {
  // The other order leaves a registration pointing at a folder that is gone: the connector still
  // loads, still fails, and the thing that would have explained it no longer exists.
  const src = fs.readFileSync(path.join(__dirname, '../../src/main/connectors.ts'), 'utf8');
  const i = src.indexOf('export async function deleteCustom');
  const fn = src.slice(i, src.indexOf('\n}', i));
  assert.ok(fn.indexOf("'remove'") < fn.indexOf('rmSync'), 'unregister first');
  assert.match(fn, /still-there/, 'verify the folder actually went');
  assert.match(fn, /still-registered/, 'verify the registration actually went');
});

test('the trash only appears on the operator\'s own connectors', () => {
  const app = APP();
  assert.match(app, /if \(c\.custom\) r\.appendChild\(connTrash\(c\)\)/,
    'a trash icon on a bundled row would promise something main refuses');
});

test('confirmation escalates with the actual risk', () => {
  /* Committed → recoverable from git history → the standard danger dialog. Uncommitted, which every
     freshly added connector is → recoverable by nothing → type the name. Uniform friction trains
     people to click through it; friction that appears exactly when the action is irreversible keeps
     meaning something. */
  const app = APP();
  const i = app.indexOf('function connTrash');
  assert.ok(i > 0, 'connTrash is gone');
  const fn = app.slice(i, app.indexOf('\n}\n', i));
  assert.match(fn, /c\.tracked\s*\n?\s*\?\s*await confirmModal/, 'tracked → the shared danger dialog');
  assert.match(fn, /=== c\.id/, 'untracked → the operator must type the name');
  // Cancelling must do nothing at all.
  assert.match(fn, /if \(!ok\) return;/);
});

test('all three locales carry the delete vocabulary', () => {
  for (const l of LOCALES) {
    const d = LOC(l);
    for (const k of ['conn.deleteHint', 'conn.deleteTitle', 'conn.deleteBodyTracked',
                     'conn.deleteType', 'conn.deleteConfirm', 'conn.deleted']) {
      assert.ok(d[k] && String(d[k]).trim(), `${l} is missing ${k}`);
      assert.doesNotMatch(String(d[k]), /\bMCPs?\b/i, `${l}: ${k} names the protocol`);
    }
  }
});

test('the trash is findable but not prominent, and theme-aware', () => {
  const css = CSS();
  const i = css.indexOf('.phtrash {');
  assert.ok(i > 0, '.phtrash is missing — the icon would inherit button chrome');
  const rule = css.slice(i, css.indexOf('}', i));
  assert.doesNotMatch(rule, /#[0-9a-f]{3,6}/i, 'a pinned colour breaks one of the two themes');
  assert.match(css.slice(i, i + 400), /\.phtrash:hover[^}]*var\(--st-error\)/,
    'destructive intent should be visible on hover');
});

test('a folder under mcps/custom/ is the operator\'s, manifest or not', () => {
  // The bundled/custom line is drawn by /aios:update: `mcps/*` except `mcps/custom/` is Tier 1, so
  // Step 6.5's completeness reconcile restores a deleted bundled folder on the next sync. A trash
  // button there would revert itself — which is worse than not having one.
  const src = fs.readFileSync(path.join(__dirname, '../../src/main/connectors.ts'), 'utf8');
  const i = src.indexOf('export function customFolder');
  assert.ok(i > 0, 'customFolder is gone');
  const fn = src.slice(i, src.indexOf('\n}', i));
  assert.doesNotMatch(fn, /connector\.json/, 'requiring a manifest is what hid mint-mcp');
  assert.match(fn, /isDirectory\(\)/, 'a stray file must not read as a connector folder');
  assert.match(fn, /if \(!want\) return undefined/, 'an empty id must not match the custom root itself');
});

test('every orphan row states whether it can be deleted at all', () => {
  // Most cannot: a remote endpoint has no folder, and the ones whose code lives in ~/code are
  // somebody's source repo. Offering a trash there would promise something main refuses.
  const root = frameworkRootForTest();
  if (!root) return;
  const { other } = listConnectors(root);
  for (const o of other) {
    assert.equal(typeof o.custom, 'boolean', `${o.id}: no ownership flag`);
    assert.equal(typeof o.tracked, 'boolean', `${o.id}: no tracked flag`);
    if (o.tracked) assert.ok(o.custom, `${o.id}: tracked implies we found its folder`);
  }
  const app = APP();
  assert.match(app, /if \(o\.custom\) r\.appendChild\(connTrash/, 'the trash must be gated on ownership');
});

test('the custom index is maintained by the code that changes the folder', () => {
  /* The vault rule — a folder with an `_index.md` gets updated when its contents change — lived in
     someone's memory, so two connectors were added and deleted through this card without it being
     touched. Safe to own: /aios:update explicitly EXCLUDES mcps/custom/_index.md from the Tier-1
     sync, so nothing upstream fights us for it. */
  const src = fs.readFileSync(path.join(__dirname, '../../src/main/connectors.ts'), 'utf8');
  const i = src.indexOf('export function updateCustomIndex');
  assert.ok(i > 0, 'updateCustomIndex is gone');
  const fn = src.slice(i, src.indexOf('\n}', i));
  // Narrow by construction: only table rows, and a table it does not recognise is left alone.
  assert.match(fn, /return;\s*\/\/ no table we recognise/, 'never rebuild a malformed index');
  assert.match(fn, /replace\(\/\\\|\/g/, 'a pipe in a service name would split the cell');
  assert.doesNotMatch(fn, /writeFileSync\(file, ['"`]/, 'it must never write a whole new file');

  const both = ['add', 'remove'];
  for (const a of both) assert.ok(src.includes(`'${a}'`), `${a} path missing`);
  assert.match(src, /updateCustomIndex\(framework, id, 'remove'\)/, 'delete must maintain it');
  assert.match(src, /updateCustomIndex\(framework, id, 'add', label\)/, 'add must maintain it');
});

/* ── the placeholder that reached a live registration ─────────────────────── */

test('{home} is substituted too — it was not, and it created a folder called {home}', () => {
  /* Real incident, found by the operator: google-workspace's manifest sets
     WORKSPACE_MCP_CREDENTIALS_DIR to "{home}/.google_workspace_mcp/credentials". substitute()
     handled {framework} only, so the literal string was registered, and the server created
     `<framework>/{home}/.google_workspace_mcp/credentials` and wrote OAuth state into it. */
  const d = parseManifest(ok({
    requires: ['{home}/.config/thing'],
    register: { transport: 'stdio', command: 'x', args: ['{home}/a', '{framework}/b'],
                env: { DIR: '{home}/.creds', OTHER: '{framework}/z' } },
  }))!;
  const s = substitute(d, '/fw', '/Users/me');
  assert.equal(s.requires[0], '/Users/me/.config/thing');
  assert.equal(s.register!.args![0], '/Users/me/a');
  assert.equal(s.register!.args![1], '/fw/b');
  assert.equal(s.register!.env!.DIR, '/Users/me/.creds');
  assert.equal(s.register!.env!.OTHER, '/fw/z');
});

test('an unsubstituted placeholder can never be registered — ANY placeholder, not just the known two', () => {
  /* The defect was not "we forgot {home}". It was that an unknown placeholder passed through
     silently, so the failure mode scales with every placeholder canonical adds next. This refuses
     all of them rather than being taught about them one incident at a time. */
  assert.deepEqual(unsubstituted(['/fine/path', 'also fine']), []);
  assert.deepEqual(unsubstituted(['{home}/x']), ['{home}/x']);
  assert.deepEqual(unsubstituted(['{vault}/x']), ['{vault}/x'], 'a placeholder we have never seen must still be refused');
  // {ask:} is resolved from operator answers at registration time, so it is not a leftover.
  assert.deepEqual(unsubstituted(['{ask:token}']), []);
});

test('addArgv refuses to build a command containing a placeholder', () => {
  const d = def({ register: { transport: 'stdio', command: 'x', args: ['{home}/never'] } });
  assert.equal(addArgv(d), null, 'better no registration than a broken one that looks fine');
  const okd = def({ register: { transport: 'stdio', command: 'x', args: ['/resolved'] } });
  assert.ok(addArgv(okd), 'a fully resolved command must still build');
});

test('no manifest on disk resolves to a command carrying a placeholder', () => {
  // The end-to-end version: every bundled manifest, substituted with real values, must produce a
  // registration with nothing left to expand.
  const root = frameworkRootForTest();
  if (!root) return;
  let checked = 0;
  for (const d of mainManifests(root)) {
    const argv = addArgv(d, Object.fromEntries(
      Object.entries(d.register?.env ?? {}).map(([k]) => [k, 'x'])));
    if (!argv) continue;              // needs-key without answers, or deliberately unregisterable
    assert.deepEqual(unsubstituted(argv), [], `${d.id}: ${unsubstituted(argv).join(', ')}`);
    checked++;
  }
  console.log(`    ${checked} manifest(s) resolve to placeholder-free commands`);
});

/* ── first run: a directory is not a framework ─────────────────────────────── */

test('the first-run guard asks readiness, not whether paths resolve', () => {
  /* fsRoots() only reports path resolution, and BOTH resolve for a directory that is not a
     framework: frameworkRoot() succeeds on an empty dir, and vaultRoot() falls back to the
     framework root when vault/ is missing — so `!framework || !vault` could never be true unless
     ~/aios was absent entirely. Found by walking a virgin instance: Setup did not open, the Home
     tab did. A newcomer whose clone failed halfway (which leaves the directory behind) would land
     on Home with nothing working and no route to Setup, since railSetup ships hidden. */
  const app = APP();
  const i = app.indexOf('FIRST RUN: with no framework');
  assert.ok(i > 0, 'the first-run guard is gone');
  const guard = app.slice(i, i + 1600);
  assert.match(guard, /glassShell\.readiness\(\)/, 'readiness applies the doctor\'s markers');
  assert.match(guard, /!r\.framework \|\| !r\.vault/);
  /* Comments stripped: the guard's own explanation names fsRoots() as the thing it replaced, and
     without this the check fails on its own documentation — the fourth time that shape appeared
     tonight, so it is a habit of these source-grep guards, not an accident. */
  const code = guard.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  assert.doesNotMatch(code, /fsRoots\(\)/, 'path resolution cannot answer "is this a framework"');
});

test('readiness uses the same framework marker as the doctor — one definition, not one per caller', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/main/aios.ts'), 'utf8');
  const i = src.indexOf('function readinessUncached');
  const fn = src.slice(i, src.indexOf('\n}', i));
  assert.match(fn, /existsSync\(path\.join\(r, 'CLAUDE\.md'\)\)/, 'an empty dir reported framework: true');
  assert.doesNotMatch(fn, /framework: !!r\b/, 'path existence is not framework existence');
  // The doctor's own check must still use the same marker, or they diverge again.
  assert.match(src, /const ok = !!root && fs\.existsSync\(path\.join\(root, 'CLAUDE\.md'\)\)/);
});

test('and readiness actually reports false for a directory that is not a framework', () => {
  // Exercised, not grepped: the empty scratch dir used for virgin runs.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'notaframework-'));
  const prev = process.env.GLASS_FRAMEWORK_PATH;
  process.env.GLASS_FRAMEWORK_PATH = dir;
  try {
    delete require.cache[require.resolve('../main/aios')];
    const aios = require('../main/aios') as { readiness: () => { framework: boolean; vault: boolean } };
    const r = aios.readiness();
    assert.equal(r.framework, false, 'an empty directory must not read as a framework');
    assert.equal(r.vault, false, 'and vaultRoot()\'s fallback must not read as a vault');
  } finally {
    if (prev === undefined) delete process.env.GLASS_FRAMEWORK_PATH; else process.env.GLASS_FRAMEWORK_PATH = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ── the handover step: copy and one button ────────────────────────────────── */

test('the handover step shows no check rows', () => {
  /* Everywhere else the rows ARE the point — each is something the operator can see and fix. On
     this step they list what the guided conversation is about to do, and they contradicted the copy
     directly above: the paragraph promises "it sets up your vault" while a red row announces "no
     vault/00 - notes under the framework root", which reads as a fault rather than a starting
     condition. Eight rows, seven labelled "optional", in front of the one button that resolves all
     of them. */
  const app = APP();
  assert.match(app, /for \(const c of \(s\.id === 'firstrun' \? \[\] : s\.checks\)\)/,
    'the handover step must render no check rows');
});

test('but the checks still RUN — the display is suppressed, not the verification', () => {
  // The step is proved done by its checks and auto-advances on that proof. Suppressing the
  // verification instead of the rendering would break the gate, silently.
  const app = APP();
  const i = app.indexOf("for (const c of (s.id === 'firstrun'");
  const near = app.slice(Math.max(0, i - 1200), i);
  assert.match(near, /The checks still RUN/, 'the distinction must be stated where someone would break it');
  // s.checks is still what drives state elsewhere.
  assert.match(app, /s\.checks/, 'checks must remain part of the step model');
});

test('nothing offers to start a project before the AIOS exists', () => {
  // It sat in Advanced on the step where framework AND vault are both still missing.
  const app = APP();
  assert.doesNotMatch(app, /onboarding\.firstProject/, 'the button is gone');
  for (const l of LOCALES) {
    const d = LOC(l);
    assert.ok(!('onboarding.firstProject' in d), `${l}: dead string left behind`);
    assert.ok(!('onboarding.firstProjectPrompt' in d), `${l}: dead string left behind`);
  }
  // With nothing in it, the Advanced disclosure must not render at all.
  // The guard is now `childElementCount && earned` — empty Advanced still never renders, and a
  // non-empty one waits until the step's primary action was tried (see "Advanced is earned").
  assert.match(app, /if \(advBody\.childElementCount && earned\) bd\.appendChild\(adv\)/,
    'an empty Advanced block would still show a caret to open');
});

/* ── the completion panel's second button ─────────────────────────────────── */

test('the tour button states the promised trigger phrase instead of guessing', () => {
  /* This panel renders only when the stepper is done, and `personalized` is the single REQUIRED
     check of the firstrun step — so it can only ever appear on an already-personalized vault. A
     bare `/aios:cold-start-interview` there asks the command to infer that Core is done. Its own
     Detection section names this button as the problem: a door "that never made any promise". The
     phrase below is the one the interview promises twice, at Step 0 and in Step 11's close. */
  const app = APP();
  assert.match(app, /'\/aios:cold-start-interview show me the full tour'/,
    'pass the promised phrase, do not make the command infer the door');
  assert.doesNotMatch(app, /setup\.deepenContext/, '"deepen your context" was wrong for the only state it renders in');
  assert.match(app, /t\('setup\.fullTour'\)/);
});

test('the tour strings exist in all three locales, and the dead one is gone', () => {
  for (const l of LOCALES) {
    const d = LOC(l);
    for (const k of ['setup.fullTour', 'setup.fullTourHint']) {
      assert.ok(d[k] && String(d[k]).trim(), `${l} is missing ${k}`);
    }
    assert.ok(!('setup.deepenContext' in d), `${l}: dead string left behind`);
    // The hint must reassure a RETURNING operator that nothing is being redone.
    assert.match(String(d['setup.fullTourHint']), /identity|identidad|identidade/i,
      `${l}: the hint should say their identity and context stay as they are`);
  }
});

test('personalized is what gates the completion panel — so the button can assume it', () => {
  // If this ever stops being the required check, the button's assumption breaks silently.
  const src = fs.readFileSync(path.join(__dirname, '../../src/core/onboarding.ts'), 'utf8');
  const i = src.indexOf("id: 'firstrun'");
  assert.ok(i > 0, 'the firstrun step is gone');
  assert.match(src.slice(i, i + 200), /required: \['personalized'\]/,
    'the tour button assumes a personalized vault because this gate guarantees one');
});

test('needs-install opens a guided SESSION, not a terminal', () => {
  /* Three designs. A disabled button (clicked, nothing happened). Then a real terminal running
     `mcps/setup.sh` — which on a clean-user install printed a wall of expert instructions and
     "All MCPs installed" having installed NOTHING, because setup.sh matches FOLDER names
     (`nano-banana-mcp`) and we passed the connector id. A static terminal cannot notice that its
     own success line lied; a session can. The framework's installer says the same in its output:
     "ask Claude to run /mcps-setup — it walks you through tokens + register + verify". */
  const app = APP();
  const i = app.indexOf("if (c.state === 'needs-install')");
  assert.ok(i > 0, 'the needs-install branch is gone');
  const branch = app.slice(i, i + 500);
  assert.match(branch, /connectSession\(c, 'install'\)/, 'it must hand off to a session');
  assert.doesNotMatch(branch, /createPane|bash /, 'no raw terminal from this state');
  assert.doesNotMatch(branch, /connectorsConnect/, 'still no Connect from this state');
});

test('the install brief carries BOTH traps that were hit for real', () => {
  const app = APP();
  const i = app.indexOf("if (kind === 'install')");
  const brief = app.slice(i, app.indexOf("} else if (kind === 'provided')", i));
  // 1. the argument is the FOLDER name, not the connector id
  assert.match(brief, /folder/, 'the brief must pass the folder name');
  assert.match(app, /const folder = c\.id \+ '-mcp'/);
  // 2. setup.sh's success line is unconditional — it says "All MCPs installed" having done nothing
  assert.match(brief, /do not trust its output/i, 'the session must be warned the success line lies');
  assert.match(brief, /Verify the file it was supposed to create actually exists/i);
});

test('every bundled Connect goes through a session — Stitch is why', () => {
  /* Stitch's manifest says one-click with no env, so it registered instantly and reported
     "connected" — while the installer's own notes require STITCH_API_KEY. We shipped a
     registration that could not work because we trusted a manifest field over the thing it
     describes, and the operator's reaction was the tell: "it just said connected, so I distrusted
     it." A session verifies instead of asserting. */
  const app = APP();
  assert.doesNotMatch(app, /if \(c\.connect !== 'one-click' \|\| !c\.canConnect\)/,
    'a manifest claiming one-click is not evidence the connector needs nothing');
  const i = app.indexOf("brief = [\n      'Help me connect");
  const generic = app.slice(app.indexOf('} else {', app.indexOf('async function connectSession')), app.indexOf('toast(t(\'conn.handing\'')); 
  assert.match(generic, /Do not assume the manifest is complete/,
    'the brief must tell the session not to trust the manifest either');
});

test('no connector action opens a document instead of a conversation', () => {
  // "Open the guide" used to open a README in a viewer tab — the same handoff as the terminal, one
  // format over: a document given to someone who does not yet know what to do with it.
  const app = APP();
  assert.doesNotMatch(app, /openConnectorDocs/, 'the README-tab path is gone');
  const i = app.indexOf("if (c.state === 'provided')");
  assert.match(app.slice(i, i + 400), /connectSession\(c, 'provided'\)/);
});

test('the step count is derived from the list, never written in prose', () => {
  /* The subhead said "Seven steps" while ONBOARDING_STEPS has four — the same drift that made the
     handover prompt claim "11 steps" against canonical's 13, and for the same reason: a number
     living in a different file from the list it describes. Caught on a real clean-user screenshot. */
  const app = APP();
  assert.match(app, /t\('setup\.onboardingSub', \{ n: String\(st\.steps\.length\) \}\)/,
    'the count must come from the step list at render time');
  for (const l of LOCALES) {
    const sub = String(LOC(l)['setup.onboardingSub']);
    assert.match(sub, /\{n\}/, `${l}: no placeholder — the number is back in prose`);
    assert.doesNotMatch(sub, /\b(Four|Seven|Cuatro|Siete|Quatro|Sete|\d+)\s/i,
      `${l}: a literal count in the subhead will drift`);
    // And it should not open by advertising terminals on the flow whose promise is you meet none.
    assert.doesNotMatch(sub, /terminal/i, `${l}: terminals in the first sentence is the wrong note`);
  }
});

test('Advanced is earned — hidden until the primary was tried and the step is still open', () => {
  /* Each step's Advanced holds a REAL alternate lane (per-tool installs, switch-account, a PAT for
     a machine where browser auth is blocked), so blanket removal would delete someone's only route.
     But before the primary has run they are noise — and on step 1 they offer to do individually what
     the one button does at once, the choice the code's own comment says the operator cannot make. */
  const app = APP();
  assert.match(app, /const earned = stepTried\.has\(s\.id\) && !s\.done;/);
  assert.match(app, /if \(advBody\.childElementCount && earned\) bd\.appendChild\(adv\)/,
    'a non-empty Advanced must still be withheld until earned');
  // Recorded once, centrally — a new step cannot forget to opt in.
  const i = app.indexOf('function buildStepActions');
  assert.match(app.slice(i, i + 700), /acts\.addEventListener\('click'[\s\S]*stepTried\.add\(s\.id\)/,
    'the primary attempt must be recorded where every step gets it for free');
  // Session-scoped: a fresh launch deserves a clean first attempt at the primary path.
  assert.doesNotMatch(app, /localStorage[^\n]*stepTried/, 'persisting it would resurface the noise');
});

test('the alternate lanes still exist — this gates them, it does not delete them', () => {
  const app = APP();
  for (const k of ['onboarding.installGit', 'onboarding.installNode', 'setup.installClaude',
                   'onboarding.switchAccount', 'onboarding.usePat', 'onboarding.patHint']) {
    assert.ok(app.includes(k), `${k} was removed — that is a lost escape hatch, not a cleanup`);
  }
});

/* ── step copy: why and what, in words they already have ──────────────────── */

test('every step has a tag — the action is the title, the tag is what it IS', () => {
  const app = APP();
  assert.match(app, /t\('onboarding\.tag\.' \+ s\.id\)/, 'no tag slot in the step head');
  // On the HEAD, not the body: a collapsed/done step must still explain itself, which is when
  // someone scrolls back asking "wait, what was GitHub for?".
  const i = app.indexOf('function stepEl');
  const head = app.slice(i, app.indexOf('return box;', i));
  assert.match(head, /step-namewrap[\s\S]*step-tag/, 'the tag must be built into the step head');
  for (const l of LOCALES) {
    const d = LOC(l);
    for (const id of ['prereqs', 'login', 'github', 'firstrun']) {
      const tag = d[`onboarding.tag.${id}`];
      assert.ok(tag && String(tag).trim(), `${l}: onboarding.tag.${id} missing`);
      assert.ok(String(tag).length < 60, `${l}: tag ${id} is a second heading, not a gloss`);
    }
  }
});

test('no operator-visible step-1 copy names a tool they will never type — prose OR tooltip', () => {
  /* Widened after the narrow version passed while `setup.phase1Hint` — the TOOLTIP on the primary
     button — still read "Homebrew, the toolchain, Obsidian and Claude Code". #94 mode 8: I fixed the
     prose and then interrogated the prose. The class is operator-visible step-1 copy, and it has
     more than one surface.
     `setupCheck.ghNoBrew` is the ONE justified exception and is asserted as such: it fires only when
     Homebrew on a shared Mac belongs to another account, which IS the problem — naming it is what
     makes the message actionable, and removing it would leave the operator stuck with no reason. */
  for (const l of LOCALES) {
    const d = LOC(l);
    for (const k of ['setup.phase1Hint', 'setup.phase1', 'onboarding.step.prereqs']) {
      const v = String(d[k] ?? '');
      for (const w of ['Homebrew', 'toolchain', 'Node.js', 'npm']) {
        assert.ok(!v.includes(w), `${l}/${k}: still names "${w}" — a surface the prose fix missed`);
      }
    }
    const brew = Object.entries(d).filter(([, v]) => String(v).includes('Homebrew')).map(([k]) => k);
    assert.deepEqual(brew, ['setupCheck.ghNoBrew'],
      `${l}: Homebrew may appear ONLY in the shared-Mac diagnostic, found ${JSON.stringify(brew)}`);
  }
});

test('no step prose names a tool the operator will never type', () => {
  /* The de-jargoning sentence used to name Homebrew, Git, Node, Obsidian AND Claude Code — five
     names, in the paragraph whose job is to remove them. The rows below already list what gets
     installed; prose carries the WHY. */
  for (const l of LOCALES) {
    const d = LOC(l);
    for (const id of ['prereqs', 'login', 'github', 'firstrun']) {
      const v = String(d[`onboarding.sub.${id}`] ?? '');
      for (const w of ['Homebrew', 'Node.js', 'npm', 'CLAUDE.md', 'model agnostic', 'model-agnostic']) {
        assert.ok(!v.includes(w), `${l}/${id}: prose still names "${w}"`);
      }
    }
  }
});

test('the Claude plan is stated up front, in every locale', () => {
  // Zero copy mentioned it before. A newcomer could reach step 2 and meet an unannounced paywall —
  // on the screen where the flow either earns trust or loses it.
  const pat = { en: /paid Claude plan is required/i, es: /plan pago de Claude/i, 'pt-br': /plano pago do Claude/i };
  for (const l of LOCALES) {
    assert.match(String(LOC(l)['onboarding.sub.login']), pat[l as keyof typeof pat], `${l}: no plan sentence`);
  }
});

test('step strings carry no markdown and no newlines — el() sets textContent', () => {
  /* `**bold**` would ship as literal asterisks and `\n\n` collapses to a space. The fix is a
     separate note key, NOT innerHTML — reaching for innerHTML in this file is what wiped the
     explorer refresh button (#92). */
  for (const l of LOCALES) {
    for (const [k, v] of Object.entries(LOC(l))) {
      if (!k.startsWith('onboarding.sub.') && !k.startsWith('onboarding.tag.') && !k.startsWith('onboarding.note.')) continue;
      assert.ok(!String(v).includes('**'), `${l}/${k}: markdown bold`);
      assert.ok(!String(v).includes('\n'), `${l}/${k}: newline`);
    }
  }
  const app = APP();
  assert.match(app, /t\('onboarding\.note\.' \+ s\.id\)/, 'the note line is gone');
  const code = noComments(app);
  const j = code.indexOf("const note = t('onboarding.note.");
  assert.ok(j > 0, 'the note line is gone');
  assert.doesNotMatch(code.slice(j - 400, j + 400), /innerHTML/, 'never innerHTML in the step body');
  // …and the stripper actually works, so passing means something.
  assert.equal(noComments('/* innerHTML */ x'), ' x');
});

test('a first launch opens in Facing — the layout that reads well with the explorer open', () => {
  /* Stacked and Facing differ only once the explorer is showing, and that is precisely when a
     newcomer first opens it. From clean-user testing: Facing is the nicer arrangement at that
     moment, so it should be what someone who has never chosen sees. A saved preference still
     wins — this changes the default, never an operator's choice. */
  const app = APP();
  assert.match(app, /migratePreset\(layoutState\.preset\) : 'Facing'/,
    'the fallback preset must be Facing');
  assert.match(app, /LAYOUTS\.includes\(migratePreset\(layoutState\.preset\)\)/,
    'a saved preset must still take precedence over the default');
  /* And the explorer must be OPEN by default, or the line above buys nothing. The explorer
     started hidden on first run for its own sound reason — a file tree of a vault the newcomer
     has not created yet. But the two defaults were chosen separately and cancel each other:
     with the explorer hidden, Facing and Stacked render IDENTICALLY, so a first launch shows
     neither the arrangement nor the change. They are asserted together here because they are
     one decision, and splitting them is how the pair silently drifted apart the first time. */
  assert.match(app, /let xOn = layoutState\.xOn !== false;/,
    'absent saved state must mean the explorer is showing');
  assert.doesNotMatch(app, /let xOn = 'xOn' in layoutState/,
    'the first-run-hidden form makes the Facing default invisible');
});
