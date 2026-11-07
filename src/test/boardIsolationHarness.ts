/**
 * #91 — Electron main script for boardIsolation.e2e.test.ts. NOT the App: it boots no workbench, no
 * terminals and no spawn-inbox, so it can run beside a live App without competing for anything.
 *
 * It installs the SAME protocol handler and navigation guard the App installs (src/main/boards.ts),
 * loads the hostile board from boardProbe.ts in a frame configured like the App's card, and prints
 * what happened. The test process owns the hit server and does the judging.
 *
 *   BOARD_PROBE_MODE=guarded  the board viewer: aios-board: protocol, sandbox="", navigation guard
 *   BOARD_PROBE_MODE=control  the same page the way the HTML viewer opens a file today (file://,
 *                             sandbox="allow-scripts", plus allow-forms, no guard). It MUST reach the network, or the
 *                             probe proves nothing.
 */
import { app, BrowserWindow, protocol } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { registerBoardScheme, installBoardProtocol, guardBoardNavigation } from '../main/boards';
import { writeHostileBoard, recordRequests, sleep, CLICK_POINTS } from '../main/boardProbe';
import { boardUrl, boardOrigin } from '../core/boards';

const mode = process.env.BOARD_PROBE_MODE === 'control' ? 'control' : 'guarded';
const fx = writeHostileBoard(Number(process.env.BOARD_PROBE_PORT));
process.env.AIOS_BOARDS_DIR = fx.root;
registerBoardScheme(protocol);
app.on('window-all-closed', () => { /* the harness exits on its own */ });

void app.whenReady().then(async () => {
  const served: string[] = [];
  const blocked: string[] = [];
  const requested: string[] = [];
  if (mode === 'guarded') installBoardProtocol(protocol, (f) => served.push(f));
  const win = new BrowserWindow({ show: false, width: 820, height: 620, webPreferences: { sandbox: true, contextIsolation: true } });
  const stop = recordRequests(win.webContents, requested);
  if (mode === 'guarded') guardBoardNavigation(win.webContents, (_from, to) => blocked.push(to));
  const src = mode === 'guarded' ? boardUrl(fx.name, Date.now()) : pathToFileURL(path.join(fx.dir, 'index.html')).href;
  // control: the HTML viewer's sandbox, plus allow-forms so the form click is observable there
  const sandbox = mode === 'guarded' ? '' : 'allow-scripts allow-forms';
  const parent = path.join(path.dirname(fx.root), 'parent.html');
  const intruderUrl = `${boardOrigin(fx.name)}/index.html?v=intruder`;
  const intruder = `<script>const f = document.createElement('iframe'); f.src = '${intruderUrl}'; document.documentElement.appendChild(f);</script>`.replace(/"/g, '&quot;');
  // the attributes the App's card sets (renderer/app.js refreshBoards)
  fs.writeFileSync(parent, `<!doctype html><meta charset="utf-8"><body style="margin:0">`
    + `<iframe id="b" sandbox="${sandbox}" referrerpolicy="no-referrer" allow="" style="width:800px;height:600px;border:0" src="${src}"></iframe>`
    /* the intruder: a page the way the HTML viewer runs one (scripts on, its own frame) trying to put
       the board in a frame of its own. Only the App's page may mount a board. */
    + (mode === 'guarded' ? `<iframe sandbox="allow-scripts" style="width:10px;height:10px;border:0" srcdoc="${intruder}"></iframe>` : ''));
  await win.loadFile(parent);
  win.webContents.debugger.attach('1.3');
  await sleep(1500);   // the page's own attempts
  /* The vectors that need a person: a click on the link (navigation + ping) and on the form's button. */
  for (const [x, y] of CLICK_POINTS) {
    // through DevTools' input domain: sendInputEvent needs a focused window, which a test must not take
    for (const type of ['mousePressed', 'mouseReleased']) {
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    }
    await sleep(400);
  }
  await sleep(2500);   // past the page's 4 s meta refresh
  /* The other way a board frame could leave: its parent pointing it somewhere else. In the App only
     the card ever sets the frame's src, but the guard must hold whoever asks. */
  await win.webContents.executeJavaScript(`document.getElementById('b').src = ${JSON.stringify(fx.net + '/parent-set')}; 1`);
  await sleep(1500);
  stop();
  process.stdout.write('PROBE_RESULT ' + JSON.stringify({ mode, fx, served, blocked, requested }) + '\n');
  app.exit(0);
});
