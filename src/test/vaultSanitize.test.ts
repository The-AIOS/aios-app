/**
 * The vault viewer renders Markdown notes, and a note is not only the operator's own writing:
 * sessions write mails, web pages and attachments into the vault. marked passes raw HTML through,
 * and this renderer holds the pty bridge, so a parsed note must never reach the DOM unsanitized.
 *
 * Source-reading invariants in the style of chatSkin.test.ts, each paired with a NEGATIVE CONTROL
 * (the same check against a deliberately broken copy must fail, or the check proves nothing).
 * The browser DOM is not available here, so the walk itself is covered by the policy tables and
 * by the hidden-window run described in the PR.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

const app = fs.readFileSync('renderer/app.js', 'utf8');

function fnBody(src: string, name: string): string {
  const re = new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`);
  return re.exec(src)?.[0] ?? '';
}
function setOf(src: string, name: string): string {
  return new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`).exec(src)?.[1] ?? '';
}
function guarded(name: string, check: (src: string) => boolean, breakIt: (src: string) => string): void {
  test(name, () => {
    assert.ok(check(app), `${name}: the check does not hold on the real source`);
    const broken = breakIt(app);
    assert.notEqual(broken, app, `${name}: the negative control did not change anything`);
    assert.equal(check(broken), false, `${name}: the check still passes on a deliberately broken copy`);
  });
}

/** Every place that turns marked output into DOM. */
const markedSinks = (src: string): string[] => [...src.matchAll(/^.*marked\.parse\(.*$/gm)].map((m) => m[0].trim());

guarded('every marked.parse in the vault viewer goes through vaultSanitize, none straight into innerHTML',
  (src) => {
    const sinks = markedSinks(src);
    return sinks.length > 0 && sinks.every((l) => /vaultSanitize\(marked\.parse\(/.test(l)) && !/innerHTML\s*=\s*marked\.parse/.test(src);
  },
  (src) => src.replace('md.replaceChildren(vaultSanitize(marked.parse(src)));', 'md.innerHTML = marked.parse(src);'));

guarded('vaultSanitize parses into an inert <template> and walks every element',
  (src) => {
    const b = fnBody(src, 'vaultSanitize');
    return /document\.createElement\('template'\)/.test(b) && /VAULT_DROP\.has\(tag\)/.test(b) && /return tpl\.content/.test(b);
  },
  (src) => src.replace("if (VAULT_DROP.has(tag)) { child.remove(); continue; }", ''));

guarded('only allowlisted attributes survive (no on* handler, no style, no srcdoc)',
  (src) => {
    const b = fnBody(src, 'vaultSanitize');
    const attrs = setOf(src, 'VAULT_ATTRS');
    return /!VAULT_ATTRS\.has\(name\)/.test(b) && /child\.removeAttribute\(a\.name\)/.test(b)
      && !/'on|'style'|'srcdoc'|'formaction'/.test(attrs);
  },
  (src) => src.replace("const VAULT_ATTRS = new Set(['href',", "const VAULT_ATTRS = new Set(['onerror', 'href',"));

guarded('links and image sources with a scriptable scheme are stripped',
  (src) => {
    const u = fnBody(src, 'vaultSafeUrl');
    return /\^\(https\?\|mailto\):/.test(u) && /return false;/.test(u) && /\\u0000-\\u0020/.test(u)
      && /data:image\\\/\(png\|jpe\?g\|gif\|webp\|bmp\);/.test(u);
  },
  (src) => src.replace("if (/^(https?|mailto):/i.test(v)) return true;", "if (/^(https?|mailto|javascript):/i.test(v)) return true;"));

test('the drop list covers every element that can run or embed code, and the allow list admits none of them', () => {
  const drop = setOf(app, 'VAULT_DROP');
  const allow = setOf(app, 'VAULT_TAGS');
  for (const bad of ['SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'SVG', 'MATH', 'STYLE', 'LINK', 'META', 'BASE', 'TEMPLATE']) {
    assert.match(drop, new RegExp(`'${bad}'`), `${bad} must be dropped`);
    assert.doesNotMatch(allow, new RegExp(`'${bad}'`), `${bad} must not be allowed`);
  }
  // inputs other than task checkboxes become text
  assert.match(fnBody(app, 'vaultSanitize'), /tag === 'INPUT' && \(child\.getAttribute\('type'\) \|\| ''\)\.toLowerCase\(\) !== 'checkbox'/);
});

/* Behaviour, not only source: vaultSafeUrl is pure, so it is RUN here. A source-pinned check passed on a copy of the patch
   whose control-character range had been mangled in transit into a regex that does not even compile (a SyntaxError that
   would have stopped the whole renderer from loading); running the function is what catches that class. */
test('vaultSafeUrl, run: scriptable schemes are refused however they are disguised, ordinary links and images pass', () => {
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  const i = app.indexOf('function vaultSafeUrl(');
  const body = app.slice(i, app.indexOf('\n}\n', i) + 2);
  const safe = new Function(body + 'return vaultSafeUrl;')() as (tag: string, name: string, v: string) => boolean;
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'java\nscript:alert(1)',
    'java\tscript:x', '\u0000javascript:x', 'vbscript:x', 'data:text/html,<script>x</script>', 'file:///etc/passwd']) {
    assert.equal(safe('A', 'href', bad), false, `href ${JSON.stringify(bad)} must be refused`);
  }
  assert.equal(safe('IMG', 'src', 'data:image/svg+xml;base64,PHN2Zz4='), false, 'svg data images can carry script');
  assert.equal(safe('IMG', 'src', 'javascript:x'), false);
  for (const ok of ['https://example.com', 'http://x.y/z', 'mailto:a@b.c', 'notes/other.md', '#heading', '../img/a.png']) {
    assert.equal(safe('A', 'href', ok), true, `href ${JSON.stringify(ok)} must pass`);
  }
  assert.equal(safe('IMG', 'src', 'file:///Users/x/vault/a.png'), true, 'local images still render');
  assert.equal(safe('IMG', 'src', 'data:image/png;base64,iVBORw0KGgo='), true);
});
