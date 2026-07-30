import { app, Menu, BrowserWindow, shell } from 'electron';
import { t } from '../i18n';

/**
 * Native application menu — the app's front face, and for a non-technical operator the
 * only complete map of what it can do. Every item emits the SAME `shell:intent` the
 * panel, palette and shortcuts use, so there is one router and many doors.
 *
 * Four rules this menu is built on:
 *
 * 1. NAME THE OUTCOME, NOT THE MECHANISM. "Import a document" beats "Ingest content";
 *    "Walk me through AIOS" beats "onboarding-aios". A label an operator must already
 *    understand is a failure of the label, not of the operator.
 * 2. GROUP BY WHAT YOU ARE TRYING TO DO. Go = take me somewhere. Rituals = the daily
 *    loop, in the order a day runs. Agents = hand work to something that can do it. Each
 *    menu has one subject and stays shallow.
 * 3. NOTHING DEAD. Every item is checked against the renderer's intent router by a test;
 *    a menu that offers what does not work is worse than a smaller menu. Browse Context
 *    was exactly that — see the `kind` note in `intent` below.
 * 4. DEVELOPER TOOLS SIT BEHIND A LABEL. Reload and DevTools are real and useful, and
 *    also the fastest way to frighten someone who opened the wrong menu — so they live in
 *    a Developer submenu rather than beside "Full Screen".
 *
 * Accelerator convention, consistent everywhere: ⌘ opens a surface · ⌘⇧ opens a picker ·
 * ⌘1–4 select layouts · ⌘0 toggles the terminal dock. The NATIVE menu owns those keys —
 * the OS resolves a menu accelerator before the renderer sees the keystroke, so a
 * duplicate handler in app.js would be silently shadowed.
 *
 * Localized via `t()`; main.ts rebuilds the whole menu when the UI locale changes, because
 * a native menu cannot re-render itself.
 */
export function installMenu(getWin: () => BrowserWindow | undefined): void {
  const intent = (kind: string, payload: Record<string, unknown> = {}) => {
    const w = getWin();
    /* `kind` LAST so the routing key can never be shadowed by a payload field. It was,
       once: a `{ kind: '' }` payload overwrote the envelope, the router matched no case,
       and Browse Context silently did nothing — from the menu AND from both panel paths
       that sent it. Ordering the spread this way makes that class of bug unreachable. */
    if (w && !w.webContents.isDestroyed()) w.webContents.send('shell:intent', { ...payload, kind });
  };
  const ritual = (slash: string) => intent('primary', { slash });
  const term = (name: string, cmd: string) => intent('terminal', { name, cmd });
  const open = (url: string) => void shell.openExternal(url);

  const template: Electron.MenuItemConstructorOptions[] = [
    /* ── AIOS: how the app is set up, and the account behind it ── */
    {
      label: t('menu.aios'),
      submenu: [
        { role: 'about', label: t('menu.about') },
        { type: 'separator' },
        { label: t('menu.settings'), accelerator: 'CmdOrCtrl+,', click: () => intent('settings') },
        { label: t('menu.installSetup'), click: () => intent('setup') },
        { type: 'separator' },
        { label: t('menu.updateFramework'), click: () => term('update', "claude '/aios:update'") },
        { label: t('menu.syncCompanies'), click: () => term('company-sync', "claude '/aios:company --sync-all'") },
        { type: 'separator' },
        { label: t('menu.loginClaude'), click: () => term('login', 'claude /login') },
        { label: t('menu.swapAccount'), click: () => intent('accountSwap') },
        { label: t('menu.logout'), click: () => term('logout', 'claude /logout') },
        { type: 'separator' },
        { role: 'hide', label: t('menu.hide') },
        { role: 'hideOthers', label: t('menu.hideOthers') },
        { role: 'unhide', label: t('menu.unhide') },
        { type: 'separator' },
        { role: 'quit', label: t('menu.quit') },
      ],
    },
    /* ── File: start something, open something, close it ── */
    {
      label: t('menu.file'),
      submenu: [
        { label: t('menu.newSession'), accelerator: 'CmdOrCtrl+N', click: () => intent('spawnWorker') },
        { label: t('menu.launchPrimary'), click: () => intent('launchPrimary') },
        /* ⌘R now opens the selector rather than spawning Claude's picker TUI — same reasoning as
           the panel button (recency order, multi-select, live sessions excluded, and the TUI's
           full-screen redraws off the critical path). The TUI remains one row inside the modal. */
        { label: t('menu.resumeSession'), accelerator: 'CmdOrCtrl+R', click: () => intent('batchResume') },
        /* File › Open Recent is where macOS has trained everyone to look, so it lives here rather
           than under View. Beside Resume deliberately: both answer "take me back to something I
           had" — this one for files and open panes, that one for closed sessions.
           ⌘⇧T, mnemonically "reopen Tab", the Chrome gesture this was asked for by name. (⌘⇧R was
           the first choice and is already Running sessions; the duplicate-accelerator test caught
           it immediately.) */
        { label: t('menu.openRecent'), accelerator: 'CmdOrCtrl+Shift+T', click: () => intent('recents') },
        { type: 'separator' },
        { label: t('menu.newTerminal'), accelerator: 'CmdOrCtrl+T', click: () => intent('terminal', { name: 'terminal' }) },
        { type: 'separator' },
        { label: t('menu.openFile'), accelerator: 'CmdOrCtrl+P', click: () => intent('quickOpen') },
        { label: t('menu.todayNote'), accelerator: 'CmdOrCtrl+Shift+Y', click: () => intent('openToday') },
        { type: 'separator' },
        { label: t('menu.closeTab'), accelerator: 'CmdOrCtrl+W', click: () => intent('closeActive') },
      ],
    },
    { role: 'editMenu' },
    /* ── Go: everything here answers "take me to…" ── */
    {
      label: t('menu.go'),
      submenu: [
        { label: t('menu.palette'), accelerator: 'CmdOrCtrl+K', click: () => intent('palette') },
        { type: 'separator' },
        { label: t('menu.home'), accelerator: 'CmdOrCtrl+Shift+H', click: () => intent('home') },
        { label: t('menu.projects'), accelerator: 'CmdOrCtrl+Shift+P', click: () => intent('pickProject') },
        // ctxKind, never kind — see the envelope note in `intent`
        { label: t('menu.browseContext'), accelerator: 'CmdOrCtrl+Shift+X', click: () => intent('pickContext', { ctxKind: '' }) },
        { label: t('menu.runningSessions'), accelerator: 'CmdOrCtrl+Shift+R', click: () => intent('pickRunning') },
        { type: 'separator' },
        { label: t('menu.toggleExplorer'), accelerator: 'CmdOrCtrl+E', click: () => intent('layout', { toggleExplorer: true }) },
        { label: t('menu.togglePanel'), accelerator: 'CmdOrCtrl+B', click: () => intent('layout', { togglePanel: true }) },
      ],
    },
    /* ── Rituals: the daily loop, in the order a day actually runs ── */
    {
      label: t('menu.rituals'),
      submenu: [
        { label: t('menu.askAios'), accelerator: 'CmdOrCtrl+J', click: () => intent('ask') },
        { type: 'separator' },
        { label: t('menu.planDay'), click: () => ritual('/aios:today') },
        { label: t('menu.closeSession'), click: () => ritual('/aios:close-session') },
        { label: t('menu.closeDay'), click: () => ritual('/aios:close-day') },
        { type: 'separator' },
        { label: t('menu.planWeek'), click: () => ritual('/aios:7plan') },
        { label: t('menu.weeklyLearnings'), click: () => ritual('/aios:weekly-learnings') },
        { type: 'separator' },
        { label: t('menu.dailyPicker'), click: () => intent('pickDaily') },
        { label: t('menu.frequentTasks'), accelerator: 'CmdOrCtrl+Shift+F', click: () => intent('pickFrequent') },
      ],
    },
    /* ── Agents: hand work to something that can do it ── */
    {
      label: t('menu.agents'),
      submenu: [
        { label: t('menu.goWithAgents'), accelerator: 'CmdOrCtrl+Shift+G', click: () => intent('pickSuggestion') },
        { type: 'separator' },
        { label: t('menu.launchAgent'), accelerator: 'CmdOrCtrl+Shift+A', click: () => intent('pickAgent') },
        { label: t('menu.loadSkill'), accelerator: 'CmdOrCtrl+Shift+S', click: () => intent('pickSkill') },
        { label: t('menu.runCommand'), accelerator: 'CmdOrCtrl+Shift+C', click: () => intent('pickCommand') },
        { type: 'separator' },
        { label: t('menu.ingest'), accelerator: 'CmdOrCtrl+Shift+I', click: () => intent('ingest') },
        { label: t('menu.generateReport'), accelerator: 'CmdOrCtrl+Shift+E', click: () => intent('reportsFlow') },
        { type: 'separator' },
        { label: t('menu.designer'), accelerator: 'CmdOrCtrl+Shift+B', click: () => intent('designer') },
      ],
    },
    /* ── View: how the window is arranged, with dev tools fenced off ── */
    {
      label: t('menu.view'),
      submenu: [
        {
          // one Layout submenu rather than four "Layout: X" rows — the four are a single
          // choice, and the accelerators stay visible where the choice is made
          label: t('menu.layout'),
          submenu: [
            { label: t('layout.stacked'), accelerator: 'CmdOrCtrl+1', click: () => intent('layout', { preset: 'Stacked' }) },
            { label: t('layout.facing'), accelerator: 'CmdOrCtrl+2', click: () => intent('layout', { preset: 'Facing' }) },
            { label: t('layout.ide'), accelerator: 'CmdOrCtrl+3', click: () => intent('layout', { preset: 'IDE' }) },
            { label: t('layout.zen'), accelerator: 'CmdOrCtrl+4', click: () => intent('layout', { preset: 'Zen' }) },
          ],
        },
        { type: 'separator' },
        /* Editor zoom. Reset is ⌘⇧0, NOT ⌘0: this app's documented convention gives ⌘0–4 to the
           layout family (terminal dock + four presets), and menu.test.ts asserts it. Adding zoom
           on ⌘0 silently stole the dock toggle for a day — the operator adapted to the
           regression without noticing it was one, which is how a convention erodes. */
        {
          label: t('menu.zoom'),
          submenu: [
            { label: t('zoom.in'), accelerator: 'CmdOrCtrl+Plus', click: () => intent('zoom', { delta: 0.1 }) },
            { label: t('zoom.out'), accelerator: 'CmdOrCtrl+-', click: () => intent('zoom', { delta: -0.1 }) },
            { label: t('zoom.reset'), accelerator: 'CmdOrCtrl+Shift+0', click: () => intent('zoom', { reset: true }) },
          ],
        },
        { type: 'separator' },
        { label: t('menu.toggleTerminals'), accelerator: 'CmdOrCtrl+0', click: () => intent('layout', { toggleSplit: true }) },
        { role: 'togglefullscreen' },
        { type: 'separator' },
        {
          label: t('menu.developer'),
          submenu: [
            /* Reload's default accelerator is ⌘R, which collides with File › Resume a
               Session. The operator action keeps ⌘R; a reload discards every open pane, so
               it must never win that race by accident. */
            { role: 'reload', accelerator: 'CmdOrCtrl+Alt+R' },
            { role: 'forceReload', accelerator: 'CmdOrCtrl+Alt+Shift+R' },
            { role: 'toggleDevTools' },
          ],
        },
      ],
    },
    { role: 'windowMenu' },
    /* ── Help: the thing that walks you through it comes first ── */
    {
      role: 'help',
      label: t('menu.help'),
      submenu: [
        /* The onboarding agent had no menu home at all. It belongs at the top: it answers
           "I have no idea what this is", which is the only question a lost operator has,
           and it is the one item a newcomer should be able to find without advice. */
        /* Spawns a session NAMED onboarding-aios rather than running a slash command in the
           primary one. The name IS the identity: CLAUDE.md's spawned-worker path globs
           agents/<bundle>/{name}.md, so the session adopts the bundled onboarding agent itself
           instead of being told about it — and it stays a separate, closable session. */
        { label: t('menu.guide'), click: () => intent('spawnNamed', { name: 'onboarding-aios' }) },
        { label: t('menu.installSetup'), click: () => intent('setup') },
        { type: 'separator' },
        { label: t('menu.shortcuts'), accelerator: 'CmdOrCtrl+/', click: () => intent('shortcuts') },
        { label: t('menu.cheatsheet'), click: () => intent('cheatsheet') },
        { type: 'separator' },
        { label: t('menu.manual'), click: () => intent('manual') },
        { label: t('menu.readme'), click: () => intent('readme') },
        { type: 'separator' },
        { label: t('menu.commons'), click: () => open('https://the-aios.org') },
        { label: t('menu.github'), click: () => open('https://github.com/The-AIOS/aios') },
      ],
    },
  ];
  if (process.platform !== 'darwin') template.shift(); // non-mac: fold app menu into defaults
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  void app; // (referenced for platform docs)
}
