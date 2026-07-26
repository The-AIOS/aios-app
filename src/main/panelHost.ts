import * as fs from 'fs';
import * as path from 'path';
import { BrowserWindow, WebContents } from 'electron';
import * as aios from './aios';

/** Framework-status cadence: poll while on screen, and collapse rapid triggers. */
const UPD_POLL_MS = 5 * 60_000;
const UPD_MIN_GAP_MS = 60_000;

/**
 * The shell-side twin of the extension's HomeViewProvider: feeds the shared
 * panel its state messages and routes its intents. Where the extension talked
 * to VS Code services, this talks to the shell — terminal intents go to the
 * renderer's grid as `shell:intent` events.
 */
export class PanelHost {
  private timer?: ReturnType<typeof setInterval>;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private updTimer?: ReturnType<typeof setInterval>;
  private updDebounce?: ReturnType<typeof setTimeout>;
  private updAt = 0;
  private watchers: fs.FSWatcher[] = [];
  private bootAt = Date.now();
  private lastReveal = 0;

  constructor(private readonly wc: WebContents) {}

  start(): void {
    this.timer = setInterval(() => this.postRunning(), 2000);
    // Framework status had NO cadence: it was posted on 'ready' and on a manual
    // click, so a running app never noticed a canonical push. Glass leans on view
    // visibility (its panel can be hidden); the App's panel is always visible, so
    // the honest equivalents are a poll plus a focus re-check (main.ts). Skipped
    // while the window is hidden/minimized — same "no wasted cycles" as Glass.
    this.updTimer = setInterval(() => {
      const w = BrowserWindow.fromWebContents(this.wc);
      if (w && !w.isDestroyed() && w.isVisible() && !w.isMinimized()) this.refreshUpdateStatus();
    }, UPD_POLL_MS);
    this.wireWatchers();
  }

  /**
   * (Re)wire the file watchers. Split out of start() because it MUST be re-runnable.
   *
   * Every watch below is wrapped in a catch for a path that does not exist yet — which is the
   * normal state of a machine that has not been set up. Wired once at boot, a newcomer therefore
   * got NO watchers at all, and nothing re-wired them when the setup session created the vault
   * minutes later. The visible symptoms were two: the calendar never grew a dot for the daily
   * note that /aios:today had just written, and the update pill stayed on "not tracked yet"
   * because nothing was watching for .aios-update to appear. Both looked like separate bugs and
   * were one: the app was still watching a machine that no longer existed.
   */
  wireWatchers(): void {
    for (const w of this.watchers.splice(0)) { try { w.close(); } catch { /* already gone */ } }
    // Live refresh on the same sources the extension watches (fs.watch is
    // enough for v0; chokidar if recursion gaps bite).
    const v = aios.vaultRoot();
    const r = aios.frameworkRoot();
    const watch = (p: string | undefined, opts?: fs.WatchOptions) => {
      if (!p) return;
      try { this.watchers.push(fs.watch(p, opts ?? {}, () => this.scheduleRefresh())); } catch { /* absent */ }
    };
    if (v) {
      watch(path.join(v, '01 - calendar'), { recursive: true });
      watch(path.join(v, '00 - notes', 'context', 'observed'));
      // exports ALSO auto-open: ask for a deck, watch the deck appear (claude.app
      // artifacts, the shell way). Throttled; skips the boot scan.
      try {
        this.watchers.push(fs.watch(path.join(v, '03 - export'), { recursive: true }, () => {
          this.scheduleRefresh();
          const now = Date.now();
          if (now - this.bootAt < 10000 || now - this.lastReveal < 8000) return;
          const newest = aios.recentOutputs(1)[0];
          if (newest && now - newest.mtime < 6000 && /\.(html?|pdf|png|jpe?g|md)$/i.test(newest.name)) {
            this.lastReveal = now;
            this.intent('openFile', { path: newest.path, mode: 'auto' });
          }
        }));
      } catch { /* absent */ }
      watch(path.join(v, '00 - notes', 'projects'));
      /* The declared context — where the operator's NAME lives. postState() has always sent it;
         nothing ever watched the file it comes from, so the greeting stayed anonymous through the
         whole interview and only filled in when /today happened to write a calendar file and
         trip a different watcher. The operator noticed exactly that: "Setup said You're in, the
         onboarding agent used my name, and the app still didn't." Their name appearing is the
         most legible possible proof that any of this worked — it should not arrive by accident. */
      watch(path.join(v, '00 - notes', 'context', 'declared'), { recursive: true });
    }
    if (r) {
      watch(path.join(r, 'USER.md'));
      // `.aios-update` is rewritten the moment /aios:update lands, so flip the pill
      // then instead of leaving it stuck on "available" until the next restart.
      // Its OWN callback, not the shared scheduleRefresh: that one also fires on
      // every calendar/export write, and each status check is a network round trip.
      try {
        this.watchers.push(fs.watch(path.join(r, '.aios-update'), () => {
          this.scheduleRefresh();
          this.updateStatusSoon();   // debounced: fs.watch commonly double-fires
        }));
      } catch { /* absent until the first sync */ }
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.updTimer) clearInterval(this.updTimer);
    if (this.updDebounce) clearTimeout(this.updDebounce);
    for (const w of this.watchers) w.close();
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => { this.postState(); this.post({ type: 'calendarDirty' }); }, 250);
  }

  private post(msg: unknown): void {
    if (!this.wc.isDestroyed()) this.wc.send('panel:post', msg);
  }

  /** Renderer intents (terminal ops, viewers) ride the same channel outward. */
  private intent(kind: string, payload: Record<string, unknown> = {}): void {
    if (!this.wc.isDestroyed()) this.wc.send('shell:intent', { ...payload, kind })   // kind LAST: the routing key can never be shadowed by a payload field;
  }

  postState(): void {
    this.post({
      type: 'state',
      operator: aios.operatorName(),
      primary: aios.primaryName(),
      agents: aios.discoverAgents().length,
      skills: aios.discoverSkills().length,
      commands: aios.discoverCommands().length,
      frequent: aios.frequentTaskCount(),
      showHints: aios.shellSettings().showHints,
      companies: aios.readCompanies(),
      collab: aios.readCollabSpaces().map((c) => c.name),
      framework: aios.readFrameworkStatus() ?? null,
      terminalMode: 'shell',
      declared: aios.countNotes('declared'),
      observed: aios.countNotes('observed'),
      projects: aios.countNotes('projects'),
      goAgents: aios.countAgentSuggestions(),
      inbox: aios.inboxItems(),
      learnings: aios.recentLearnings(),
      nudge: aios.shellSettings().showNudges
        ? (() => { const now = new Date(); return aios.nudgeState(now.getHours(), now.getDay(), aios.listRunningAgents().length); })()
        : null,
      outputs: aios.recentOutputs(),
      reports: aios.recentReports(),
    });
  }

  postRunning(): void {
    const running = aios.listRunningAgents();
    const rl = aios.rateLimit();
    const fwReal = aios.frameworkRoot() ?? '';
    const projOf = (cwd: string): string => {
      if (!cwd) return '';
      let real = cwd;
      try { real = fs.realpathSync(cwd); } catch { /* keep raw */ }
      return fwReal && real === fwReal ? '' : path.basename(real);
    };
    const mem = aios.shellSettings().showMemory ? aios.sessionMemoryMB(running.map((a) => a.pid)) : {};
    this.post({
      type: 'running',
      running: running.map((a) => ({ name: a.name, pid: a.pid, id: a.sessionId, status: a.status, proj: projOf(a.cwd), startedAt: a.startedAt, updatedAt: a.updatedAt, mem: mem[a.pid] })),
      quota: rl
        ? { has: true, fiveHour: rl.fiveHourPct, sevenDay: rl.sevenDayPct, fr: rl.fiveHourResetsAt, sr: rl.sevenDayResetsAt, showSwap: false, to: '' }
        : { has: false, fiveHour: 0, sevenDay: 0, showSwap: false, to: '' },
    });
  }

  /**
   * Re-check unless we just did. Every check is a `git ls-remote`, so rapid
   * triggers (focus toggling, a burst of file events) collapse into one.
   * `force` is for an explicit ask — the operator clicking the pill.
   */
  refreshUpdateStatus(force = false): void {
    if (!force && Date.now() - this.updAt < UPD_MIN_GAP_MS) return;
    this.postUpdateStatus();
  }

  /** Debounced variant for file-watcher edges. */
  private updateStatusSoon(): void {
    if (this.updDebounce) clearTimeout(this.updDebounce);
    this.updDebounce = setTimeout(() => this.postUpdateStatus(), 400);
  }

  postUpdateStatus(): void {
    this.updAt = Date.now();
    void aios.checkForUpdates().then((state) =>
      // inboxUpdate: the framework-update row of the "Needs you" card — null
      // when up-to-date/unknown OR while dismissed (sig = local hash, so the
      // dismissal auto-expires the moment /aios:update moves the hash)
      this.post({ type: 'updateStatus', state, framework: aios.readFrameworkStatus() ?? null, inboxUpdate: aios.updateInboxItem(state) }));
  }

  /** Messages FROM the panel — same protocol the extension speaks. */
  onMessage(msg: { type?: string; [k: string]: unknown }): void {
    switch (msg.type) {
      case 'ready':
        this.postState();
        this.postRunning();
        this.postUpdateStatus();
        this.post({ type: 'month', data: (() => { const n = new Date(); return aios.getMonthData(n.getFullYear(), n.getMonth() + 1); })() });
        return;
      case 'recheck':
        this.postState();
        this.refreshUpdateStatus(true);
        return;
      case 'navMonth':
        this.post({ type: 'month', data: aios.getMonthData(Number(msg.year), Number(msg.month)) });
        return;
      case 'ritual':
        // Glass parity: rituals run in the PRIMARY session, not a new pane each click
        this.intent('primary', { slash: `/aios:${String(msg.name)}` });
        return;
      case 'nudgeRun': {
        const raw = String(msg.command || '');
        const slash = raw.startsWith('/aios:') || raw.startsWith('/') === false ? raw : raw;
        const normalized = slash.startsWith('/aios:') ? slash : '/aios:' + slash.replace(/^\//, '').replace(/^(?:aios:|vault-commands:)/, '');
        this.intent('primary', { slash: normalized });
        return;
      }
      case 'inboxDismiss':
        // stateful dismissal: hides the item until its signature changes again
        aios.dismissInboxItem(String(msg.key ?? ''), String(msg.sig ?? ''));
        this.postState();
        if (String(msg.key) === 'update') this.postUpdateStatus();
        return;
      case 'newTerminal':
        this.intent('terminal', { name: 'terminal' });
        return;
      case 'focusTerminal':
        this.intent('focusTerminal', { pid: Number(msg.pid) });
        return;
      case 'closeTerminal':
        this.intent('closeTerminal', { pid: Number(msg.pid) });
        return;
      case 'openDay':
        this.intent('openFile', { path: aios.dailyNotePath(String(msg.date)) ?? '', mode: 'markdown' });
        return;
      case 'cmd':
        this.routeCommand(String(msg.command), (msg.args as unknown[]) ?? []);
        return;
      default:
        console.log('[panelHost] unhandled', msg.type);
    }
  }

  /** `run('aios.x')` command ids → shell actions. Pickers come with the palette stride. */
  private routeCommand(command: string, args: unknown[]): void {
    const term = (name: string, cmd: string) => this.intent('terminal', { name, cmd });
    switch (command) {
      case 'aios.openConfigMenu': this.intent('settings'); return;
      /* --name, so this is a SESSION. Without it termEnv() cannot set CLAUDE_AGENT_NAME, the
         identity ritual never runs, and it never registers in ~/.claude/sessions — the operator
         gets an unnamed terminal they cannot resume and cannot find in Running. */
      case 'aios.updateFramework': term('update', `${aios.shellSettings().claudeCmd} --name update '/aios:update'`); return;
      case 'aios.frequentMenu': this.intent('pickFrequent'); return;
      case 'aios.spawnAgent': this.intent('pickAgent'); return;
      case 'aios.skillsPicker': this.intent('pickSkill'); return;
      case 'aios.runRitualPicker': this.intent('pickCommand'); return;
      case 'aios.runningPicker': this.intent('pickRunning'); return;
      case 'aios.spawnWorker': this.intent('spawnWorker'); return;
      case 'aios.openDoc': {
        const files: Record<string, string> = { cheatsheet: 'CHEATSHEET.md', intent: 'INTENT.md', user: 'USER.md', tools: 'TOOLS.md', readme: 'README.md' };
        const f = files[String(args[0] ?? '')];
        const r = aios.frameworkRoot();
        if (f && r) this.intent('openFile', { path: path.join(r, f), mode: 'markdown' });
        return;
      }
      case 'aios.browseContext': this.intent('pickContext', { ctxKind: String(args[0] ?? 'declared') }); return;
      case 'aios.contextPicker': this.intent('pickContext', { ctxKind: '' }); return;
      case 'aios.ingest': this.intent('ingest'); return;
      case 'aios.reports': this.intent('reportsFlow'); return;
      case 'aios.goWithAgents': this.intent('pickSuggestion'); return;
      case 'aios.workspacesPicker': this.intent('pickProject'); return;
      case 'aios.personalizationsPicker': {
        const r = aios.frameworkRoot();
        if (r) this.intent('openFile', { path: path.join(r, 'USER.md'), mode: 'markdown' });
        return;
      }
      case 'aios.minimizeCards': this.post({ type: 'toggleAllCards' }); return;
      case 'aios.toggleHome': this.intent('layout', { togglePanel: true }); return;
      case 'aios.dailyPicker': this.intent('pickDaily'); return;
      case 'aios.openWalkthrough': this.intent('setup'); return;
      case 'aios.launchPrimary': { const p = aios.primaryName(); term(p, `${aios.shellSettings().claudeCmd} --name ${p}`); return; }
      case 'aios.resume': term('resume', 'claude --resume'); return;
      case 'aios.askAios': this.intent('ask'); return;
      case 'aios.revealAgent': this.intent('focusByName', { name: String(args[0] ?? '') }); return;
      case 'aios.closeAgent': this.intent('closeByName', { name: String(args[0] ?? '') }); return;
      case 'aios.closeSessionAgent': this.intent('sendByName', { name: String(args[0] ?? ''), text: '/aios:close-session' }); return;
      case 'aios.interruptAgent': this.intent('escByName', { name: String(args[0] ?? '') }); return;
      case 'aios.openLearning': this.intent('openFile', { path: String(args[0] ?? ''), mode: 'markdown', line: Number(args[1] ?? 0) }); return;
      case 'aios.openOutput': this.intent('openFile', { path: String(args[0] ?? ''), mode: 'auto' }); return;
      default:
        this.intent('toast', { text: `${command} — coming to the shell soon (use the extension meanwhile)` });
    }
  }
}
