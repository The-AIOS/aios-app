/**
 * #75: a pane's raw output is recorded as asciicast v2 and read back byte for byte.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import { headerLine, outputLine, resizeLine, parseRecording, recordingName } from '../core/ttyRecord';

const START = Date.UTC(2026, 10, 17, 18, 0, 0);

test('a recording reads back exactly: every byte of output, resizes, in order, with their times', () => {
  const chunks = ['\x1b[2J\x1b[H', '⏺ Hello\r\n', '\x1b[12A\x1b[2K✻ Worked for 3s\r\n', 'tail \u0000\u0007 bytes'];
  let file = headerLine(120, 40, START, 'lead');
  file += outputLine(5, chunks[0]) + outputLine(250, chunks[1]) + resizeLine(300, 100, 30) + outputLine(1234.4, chunks[2]) + outputLine(2000, chunks[3]);
  const r = parseRecording(file);
  assert.deepEqual(r.header, { width: 120, height: 40, timestamp: Math.floor(START / 1000), title: 'lead' });
  assert.deepEqual(r.events.filter((e) => e.kind === 'o').map((e) => (e as { data: string }).data), chunks, 'byte for byte');
  assert.deepEqual(r.events.map((e) => e.kind), ['o', 'o', 'r', 'o', 'o'], 'in order');
  assert.deepEqual(r.events[2], { t: 300, kind: 'r', cols: 100, rows: 30 });
  assert.equal(r.events[3].t, 1234, 'times in milliseconds, kept to the millisecond');
});

test('the header follows asciicast v2, so asciinema can play the file', () => {
  const h = JSON.parse(headerLine(80.7, 24, START));
  assert.deepEqual(h, { version: 2, width: 80, height: 24, timestamp: Math.floor(START / 1000) });
  assert.deepEqual(JSON.parse(outputLine(1500, 'x')), [1.5, 'o', 'x']);
  assert.deepEqual(JSON.parse(resizeLine(0, 90, 20)), [0, 'r', '90x20']);
});

test('broken lines are skipped, not fatal', () => {
  const r = parseRecording(headerLine(80, 24, START) + '{not json\n' + outputLine(1, 'a') + '[1,"z","?"]\n[2,"r","bad"]\n');
  assert.equal(r.events.length, 1);
});

test('the file name is safe and dated', () => {
  assert.match(recordingName('lead / ../x', START), /^lead-x-\d{8}-\d{9}\.cast$/);
  assert.match(recordingName('', START), /^terminal-/);
});

test('wiring: main records a pane only when asked, adds resizes, and keeps the file private', () => {
  const main = fs.readFileSync('src/main/main.ts', 'utf8');
  assert.match(main, /ipcMain\.handle\('pty:record'/);
  assert.match(main, /recordWrite\(id, outputLine\(/, 'every output chunk while recording');
  assert.match(main, /if \(rec\.bytes < RECORD_MAX_BYTES\) return;\s*endRecording\(id, 'size'\);/, 'capped (review of #75)');
  assert.match(main, /if \(recordings\.get\(id\)\?\.out === out\) endRecording\(id, 'error'\)/, 'a write error stops only its own recording, and says so');
  assert.match(main, /p\.onExit\(\(\{ exitCode \}\) => \{ endRecording\(id, 'exit'\);/, 'and so does the terminal exiting');
  assert.doesNotMatch(main.slice(main.indexOf('function recordWrite'), main.indexOf('function recordWrite') + 600), /writeSync/, 'never a synchronous write per chunk');
  assert.match(main, /resizeLine\(/, 'resizes are recorded');
  assert.match(main, /createWriteStream\(file, \{ flags: 'wx', mode: 0o600 \}\)/, 'readable by the operator alone, never appended to another recording');
  const app = fs.readFileSync('renderer/app.js', 'utf8');
  assert.match(app, /value: 'record'/, 'turned on from the tab menu');
});
