/**
 * macOS microphone: a hardened-runtime app gets NO microphone unless it is entitled to one — and
 * the denial is silent.
 *
 * Claude Code's voice mode records from inside the `claude` process, which runs in one of our
 * PTYs. macOS attributes that access to the RESPONSIBLE process — this app, not `claude` — so what
 * decides whether voice mode works is our signature, not Claude Code's. With the hardened runtime
 * on and `com.apple.security.device.audio-input` absent, the request is refused before the TCC
 * prompt is ever shown. Measured on the shipped 0.10.0 from a pane's shell:
 * `AVCaptureDevice.requestAccess(for: .audio)` returned `false` in 0.01 s, no dialog appeared,
 * the status stayed `notDetermined`, and the app never appeared under System Settings → Privacy →
 * Microphone — so there was nothing for the operator to switch on. The same `claude` in VS Code's
 * terminal records fine, because VS Code carries the entitlement.
 *
 * Nothing crashes and nothing logs, which is why it is asserted on the CONFIG here and again on
 * the signed artifact in scripts/verify-signing.mjs.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const mac = pkg.build?.mac ?? {};

/** The <key>…</key><true/> pairs of a plist, comments stripped — a key named only inside the
    explanatory comment (as the candidates in the entitlements file are) must not count. */
function grantedKeys(file: string): Set<string> {
  const xml = fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const keys = new Set<string>();
  for (const m of xml.matchAll(/<key>([^<]+)<\/key>\s*<true\s*\/>/g)) keys.add(m[1].trim());
  return keys;
}

test('the mac build is signed with the hardened runtime and an entitlements file', () => {
  /* Control: if either of these ever changes, the assertion below stops meaning what it says —
     without the hardened runtime the entitlement is not required at all. */
  assert.equal(mac.hardenedRuntime, true, 'build.mac.hardenedRuntime is expected to be on');
  assert.ok(typeof mac.entitlements === 'string' && fs.existsSync(mac.entitlements),
    'build.mac.entitlements must point at an existing file');
});

test('the main app is entitled to the microphone — or voice mode is refused without a prompt', () => {
  const granted = grantedKeys(mac.entitlements);
  /* Control on the parser itself: allow-jit is always granted (V8 needs it). If this does not see
     it, the parse is broken and the real assertion would be judging an empty set. */
  assert.ok(granted.has('com.apple.security.cs.allow-jit'),
    `parser control failed: allow-jit not found in ${mac.entitlements}`);
  assert.ok(granted.has('com.apple.security.device.audio-input'),
    `${mac.entitlements} must grant com.apple.security.device.audio-input — without it the hardened `
    + 'runtime refuses microphone access for every process in our PTYs (Claude Code voice mode) '
    + 'and macOS never shows the permission prompt');
});
