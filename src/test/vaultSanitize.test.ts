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
  (src) => src.replace('if (VAULT_DROP.has(tag)) {', 'if (false) {'));

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

/* 0.15.1 round: what was taken out is SAID, not silently gone, and remote images wait for a click. */
const chipSrc = (src: string) => src.slice(src.indexOf('const VAULT_CHIP = {'), src.indexOf('function vaultSanitize('));
guarded('a visible embed becomes a chip saying what was not shown; script, style and the like still vanish silently',
  (src) => {
    const c = chipSrc(src);
    const kinds = /const VAULT_CHIP = \{([\s\S]*?)\};/.exec(c);
    const tags = kinds ? [...kinds[1].matchAll(/([A-Z]+):/g)].map((m) => m[1]) : [];
    const drop = /const VAULT_DROP = new Set\(\[([\s\S]*?)\]\);/.exec(src);
    const dropTags = drop ? [...drop[1].matchAll(/'([A-Z]+)'/g)].map((m) => m[1]) : [];
    return tags.length > 0 && tags.every((t) => dropTags.includes(t)) && !tags.includes('SCRIPT') && !tags.includes('STYLE')
      && /if \(VAULT_CHIP\[tag\]\) child\.replaceWith\(vaultChip\(VAULT_CHIP\[tag\], vaultHttpUrl\(child\)\)\);\n\s+else child\.remove\(\);/.test(src);
  },
  (src) => src.replace('if (VAULT_CHIP[tag]) child.replaceWith(vaultChip(VAULT_CHIP[tag], vaultHttpUrl(child)));', 'if (VAULT_CHIP[tag]) child.replaceWith(child.cloneNode(true));'));

guarded('a chip never brings the content in: its only markup is the static icon, the URL is text, and only http(s) is offered',
  (src) => {
    const c = chipSrc(src);
    const inner = [...c.matchAll(/\.innerHTML = ([^;]+);/g)].map((m) => m[1]);
    return inner.length >= 1 && inner.every((x) => /^icon\(/.test(x))
      && /if \(\/\^https\?:\\\/\\\/\/i\.test\(v\)\) return v;/.test(c)
      && /words\.textContent = t\('viewer\.blocked\.' \+ kind/.test(c)
      && /void window\.glassShell\.openExternal\(url\)/.test(c);
  },
  (src) => src.replace("words.textContent = t('viewer.blocked.' + kind", "words.innerHTML = t('viewer.blocked.' + kind"));

guarded('a remote image waits for a click; a local one shows as before',
  (src) => /if \(tag === 'IMG' && \/\^https\?:\\\/\\\/\/i\.test\(String\(child\.getAttribute\('src'\) \|\| ''\)\.trim\(\)\)\) \{[\s\S]{0,200}child\.replaceWith\(vaultChip\('image', url, \(chip\) => \{[\s\S]{0,500}img\.src = url;/.test(src),
  (src) => src.replace("if (tag === 'IMG' && /^https?:\\/\\//i.test(", "if (false && /^https?:\\/\\//i.test("));

test('every chip string exists in all four languages', () => {
  for (const loc of ['en', 'es', 'pt-br', 'el']) {
    const b = JSON.parse(fs.readFileSync(`src/i18n/locales/${loc}.json`, 'utf8'));
    for (const k of ['why', 'embed', 'media', 'drawing', 'form', 'image', 'load', 'open']) assert.ok(b['viewer.blocked.' + k], `${loc}: ${k}`);
  }
});

/* 0.15.1 round 2: a note that had anything held back says so in plain words, once, at the top, like a mail app. */
guarded('a note with held-back content gets one plain-language banner, with Show images when images were held',
  (src) => /md\.replaceChildren\(vaultSanitize\(marked\.parse\(src\)\)\);\n\s+vaultHeldBanner\(md\);/.test(src)
    && /const images = chips\.filter\(\(c\) => c\.dataset\.kind === 'image' && c\.querySelector\('\.vblock-btn'\)\);/.test(src)
    && /chip\.dataset\.kind = kind;/.test(src)
    && /head\.textContent = t\('viewer\.held\.title'/.test(src) && /why\.textContent = t\('viewer\.held\.why'\)/.test(src),
  (src) => src.replace('    vaultHeldBanner(md);\n', ''));
test('the banner strings exist in all four languages', () => {
  for (const loc of ['en', 'es', 'pt-br', 'el']) {
    const b = JSON.parse(fs.readFileSync(`src/i18n/locales/${loc}.json`, 'utf8'));
    for (const k of ['title', 'why', 'showImages']) assert.ok(b['viewer.held.' + k], `${loc}: ${k}`);
  }
});

/* 0.15.1 round 3: an image that does not arrive (a remote one after Load, or a missing local file) says so in a chip. */
guarded('an image that fails to load becomes a chip, not a broken-image box',
  (src) => /img\.addEventListener\('error', \(\) => \{ if \(img\.isConnected\) img\.replaceWith\(vaultChip\('failed', url\)\); \}, \{ once: true \}\);/.test(src)
    && /child\.addEventListener\('error', \(\) => \{ if \(child\.isConnected\) child\.replaceWith\(vaultChip\('missing', '', null, name\)\); \}, \{ once: true \}\);/.test(src)
    && /if \(url && host && kind !== 'failed'\) \{/.test(src),
  (src) => src.replace("img.addEventListener('error', () => { if (img.isConnected) img.replaceWith(vaultChip('failed', url)); }, { once: true });", ''));
test('the failed and missing image strings exist in all four languages', () => {
  for (const loc of ['en', 'es', 'pt-br', 'el']) {
    const b = JSON.parse(fs.readFileSync(`src/i18n/locales/${loc}.json`, 'utf8'));
    for (const k of ['failed', 'missing']) assert.ok(b['viewer.blocked.' + k], `${loc}: ${k}`);
  }
});
