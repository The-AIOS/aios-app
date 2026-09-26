/**
 * "Show me the file, not a preview of it." — ⌘⇧-click on a printed path, and a button in the
 * viewer, both hand the file to the desktop selected in its folder (Finder / Explorer).
 *
 * The preview is the right default for reading; it is the wrong END for a file whose next step
 * happens elsewhere — an avatar uploaded to a site, a PDF attached to a mail, a deck dragged into
 * a chat. Before this, the only way from a path printed in a terminal to that folder was: ⌘-click
 * → preview → find the file in the explorer → right-click → "Reveal in Finder". Operator-reported
 * while uploading a generated image: *"that opens it here as a preview — can't it open Finder?"*
 *
 * Source assertions, deliberately: both sites are DOM/IPC glue with nothing to run headless,
 * and what these guard is the CONTRACT — which gesture goes where, and that the button exists for
 * every file rather than for one extension.
 */
import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';

const app = fs.readFileSync('renderer/app.js', 'utf8');

function slice(from: string, len: number, what: string): string {
  const i = app.indexOf(from);
  assert.ok(i >= 0, `could not find ${what} in renderer/app.js — did it get renamed?`);
  return app.slice(i, i + len);
}

test('⌘⇧-click (Ctrl+Shift) on a terminal path reveals it in the OS; plain ⌘-click still previews', () => {
  const act = slice('activate: (ev) => {', 1400, 'the path-link activate handler');
  const guard = act.indexOf('if (!ev.metaKey && !ev.ctrlKey) return;');
  const reveal = act.indexOf('if (ev.shiftKey) { void window.glassShell.revealInOS(abs); return; }');
  const preview = act.indexOf('void openViewer(abs);');
  assert.ok(guard >= 0, 'a plain click must still fall through to the terminal (text selection)');
  assert.ok(reveal > guard, 'shift is tested AFTER the ⌘/Ctrl guard — ⇧-click alone is not a gesture');
  assert.ok(preview > reveal, 'the preview stays the default; reveal is the modified gesture, and it returns');
});

test('the hover tip names both gestures, so the second one is discoverable', () => {
  const hover = slice("hover: (ev) => showPathTip(", 200, 'the path-link hover tip');
  assert.match(hover, /t\('term\.cmdClickOpen'\)/);
  assert.match(hover, /t\('term\.cmdShiftClickReveal'\)/);
});

test('the viewer header carries a "Reveal in Finder" button for EVERY file, not one extension', () => {
  const i = app.indexOf('async function openViewer(p) {');
  assert.ok(i >= 0, 'openViewer moved?');
  const body = app.slice(i, i + 7000);
  /* NOT inside the HTML-only block: the PNG button is gated by `if (HTML_EXT.test(name))`, and a
     reveal that only worked for .html would miss exactly the files that motivated it (images,
     PDFs — the non-editable ones, whose preview is a dead end). Searched from the END of that
     block: an earlier reveal exists above it — the unreadable-file branch (previewGate.test.ts) —
     and that one is not the button. */
  const htmlGate = body.indexOf('if (HTML_EXT.test(name)) {');
  const htmlGateEnd = body.indexOf('\n  }\n', htmlGate);
  assert.ok(htmlGate >= 0 && htmlGateEnd > htmlGate, 'the HTML-only block moved?');
  const btn = body.indexOf("window.glassShell.revealInOS(file.path)", htmlGateEnd);
  assert.ok(btn >= 0, 'the reveal button sits OUTSIDE the HTML-only block, after it');
  assert.ok(body.slice(btn - 400, btn).includes("t('ctx.reveal')"),
    'reuses the explorer\'s own label — one string, one meaning, across the app');
});

test('every locale carries the strings the two sites read', () => {
  for (const loc of ['en', 'es', 'pt-br']) {
    const j = JSON.parse(fs.readFileSync(`src/i18n/locales/${loc}.json`, 'utf8')) as Record<string, string>;
    for (const k of ['term.cmdShiftClickReveal', 'viewer.revealTitle', 'ctx.reveal']) {
      assert.ok(typeof j[k] === 'string' && j[k].length > 0, `${loc} is missing ${k}`);
    }
  }
});
