/**
 * The App window declares a Content Security Policy (#162), a second lock behind vaultSanitize and
 * chatSanitize (GHSA-7459-8hh5-jjrj). If untrusted HTML ever reaches the window unsanitized, the
 * browser itself refuses inline scripts, on* handlers and javascript: URLs.
 *
 * Source-reading invariants in the style of vaultSanitize.test.ts, each paired with a NEGATIVE
 * CONTROL: the same check against a deliberately broken copy must fail, or the check proves nothing.
 * Whether every view still works under the policy is the browser's to say: `npm run smoke` counts
 * each `aios-csp-violation` the window logs as an error.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

/** The pages without their comments: a comment that quotes a directive or names a tag is not markup. */
const bare = (file: string): string => fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const pages: Record<string, string> = {
  'renderer/index.html': bare('renderer/index.html'),
  'renderer/quickbar.html': bare('renderer/quickbar.html'),
};
const app = fs.readFileSync('renderer/app.js', 'utf8');
const main = fs.readFileSync('src/main/main.ts', 'utf8');

const META_RE = /<meta\s+http-equiv=["']Content-Security-Policy["']\s+content=(?:"([^"]*)"|'([^']*)')[^>]*>/i;

/** The policy as directive → sources, or null when the page declares none. */
function policyOf(html: string): Map<string, string[]> | null {
  const m = META_RE.exec(html);
  if (!m) return null;
  const out = new Map<string, string[]>();
  for (const part of (m[1] ?? m[2]).split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name && !out.has(name.toLowerCase())) out.set(name.toLowerCase(), sources);   // the first one wins, as in the browser
  }
  return out;
}

/** What actually governs a script: script-src-elem/-attr, else script-src, else default-src. */
function scriptSources(p: Map<string, string[]>): string[][] {
  const base = p.get('script-src') ?? p.get('default-src');
  return [p.get('script-src-elem') ?? base, p.get('script-src-attr') ?? base].map((s) => s ?? ['*']);
}

const UNSAFE = new Set(["'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'", "'wasm-unsafe-eval'", "'strict-dynamic'"]);

/** Scripts: own files only. No inline, no eval, no wildcard, no scheme that hands out code. */
function scriptsLocked(html: string): boolean {
  const p = policyOf(html);
  if (!p) return false;
  return scriptSources(p).every((list) => list.length > 0 && list.every((s) =>
    !UNSAFE.has(s.toLowerCase()) && !s.includes('*') && !/^(https?|data|blob|filesystem|file|javascript):?$/i.test(s)
    && !/^'(nonce|sha\d+)-/i.test(s)));   // a nonce or hash would need inline scripts to exist; none do
}

/** The policy must come before anything it governs: a <meta> CSP only covers what follows it. */
function policyFirst(html: string): boolean {
  const meta = html.search(META_RE);
  const firstLoad = html.search(/<(script|link|style|img|iframe)\b/i);
  return meta >= 0 && (firstLoad < 0 || meta < firstLoad) && meta < html.search(/<\/head>/i);
}

/** No plugin objects, no <base> hijack, no form posting anywhere. */
function sideDoorsShut(html: string): boolean {
  const p = policyOf(html);
  if (!p) return false;
  const only = (d: string, v: string): boolean => (p.get(d) ?? p.get('default-src') ?? []).join(' ') === v;
  return only('object-src', "'none'") && p.get('base-uri')?.join(' ') === "'none'" && p.get('form-action')?.join(' ') === "'none'";
}

/** The page carries no inline script and no on* handler: nothing the policy would refuse. */
function noInlineCode(html: string): boolean {
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  return scripts.every((m) => /\bsrc=/.test(m[1]) && m[2].trim() === '')
    && !/<[a-z][^>]*\son[a-z]+\s*=/i.test(html)
    && !/javascript:/i.test(html);
}

function guarded(name: string, src: string, check: (s: string) => boolean, breakIt: (s: string) => string): void {
  test(name, () => {
    assert.ok(check(src), `${name}: the check does not hold on the real source`);
    const broken = breakIt(src);
    assert.notEqual(broken, src, `${name}: the negative control did not change anything`);
    assert.equal(check(broken), false, `${name}: the check still passes on a deliberately broken copy`);
  });
}

for (const [file, html] of Object.entries(pages)) {
  guarded(`${file}: scripts may come from the App's own files only (no 'unsafe-inline', no eval)`, html, scriptsLocked,
    (s) => s.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'"));

  guarded(`${file}: dropping script-src does not fall back to an open default`, html, scriptsLocked,
    (s) => s.replace("default-src 'none'; script-src 'self';", "default-src *;"));

  guarded(`${file}: 'unsafe-eval' is refused as well`, html, scriptsLocked,
    (s) => s.replace("script-src 'self'", "script-src 'self' 'unsafe-eval'"));

  guarded(`${file}: the policy is declared before anything it governs`, html, policyFirst,
    (s) => s.replace(META_RE, '').replace(/<\/head>/i, (h) => `${META_RE.exec(s)![0]}\n${h}`));

  guarded(`${file}: object-src, base-uri and form-action are shut`, html, sideDoorsShut,
    (s) => s.replace("base-uri 'none'", "base-uri 'self'"));

  guarded(`${file}: no inline script or on* handler that the policy would have to allow`, html, noInlineCode,
    (s) => s.replace(/<\/body>|<\/head>/i, (h) => `<script>alert(1)</script>\n${h}`));
}

test('a missing policy fails the script check', () => {
  assert.equal(scriptsLocked(pages['renderer/index.html'].replace(META_RE, '')), false);
});

const report = fs.readFileSync('renderer/csp-report.js', 'utf8');
test('the refusal logger loads FIRST in both windows, right after the policy, so nothing loaded earlier goes unlogged', () => {
  for (const [file, html] of Object.entries(pages)) {
    const meta = html.search(META_RE);
    const first = html.indexOf('<script');
    assert.ok(meta >= 0 && first > meta, `${file}: the policy comes before any script`);
    assert.match(html.slice(first), /^<script src="csp-report\.js"><\/script>/, `${file}: the first script is the logger`);
  }
});

guarded('the window reports every refusal, and smoke counts it as an error', report + '\n/*MAIN*/\n' + main,
  (s) => /addEventListener\('securitypolicyviolation'[\s\S]{0,200}console\.error\(`aios-csp-violation /.test(s)
    && /msg\.startsWith\('aios-csp-violation '\)\) rendererErrors\.push/.test(s),
  (s) => s.replace("msg.startsWith('aios-csp-violation ')) rendererErrors.push", "msg.startsWith('aios-csp-violation ')) void"));
