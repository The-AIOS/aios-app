/**
 * #176: links that ask for a new window open in the default browser, never in a new App window.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import { windowOpenAction } from '../core/linkOpen';

test('web and mail links go to the default browser', () => {
  for (const u of ['https://claude.ai/artifact/x', 'http://localhost:3000', 'HTTPS://docs.google.com/d/1', 'mailto:a@b.c']) {
    assert.equal(windowOpenAction(u), 'external', u);
  }
});

test('every other scheme is refused, never opened anywhere', () => {
  for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'vscode://x', 'about:blank', '', 'https:/broken']) {
    assert.equal(windowOpenAction(u), 'deny', u);
  }
});

test('wiring: every web contents gets the handler, and new windows are always denied', () => {
  const main = fs.readFileSync('src/main/main.ts', 'utf8');
  assert.match(main, /app\.on\('web-contents-created'/, 'covers the window, webviews, boards and the quick bar');
  assert.match(main, /setWindowOpenHandler\(/);
  assert.match(main, /windowOpenAction\(/);
  const block = main.slice(main.indexOf('setWindowOpenHandler('), main.indexOf('setWindowOpenHandler(') + 400);
  assert.match(block, /action: 'deny'/, 'the App window itself is never created for a link');
  assert.doesNotMatch(block, /action: 'allow'/);
});

test('wiring: terminal links (OSC 8) open in the browser, without the blank-window detour', () => {
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  assert.match(app, /linkHandler: \{ activate: \(_e, uri\) => \{ if \(\/\^https\?:/, 'the terminal has its own link handler');
});
