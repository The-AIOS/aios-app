import * as fs from 'fs';
import * as path from 'path';
import { BrowserWindow, WebContents, nativeImage } from 'electron';
import * as aios from './aios';
import { t } from '../i18n';
import { Attention } from './attention';
import { sessionKey } from '../core/attention';

/** Framework-status cadence: poll while on screen, and collapse rapid triggers. */
const UPD_POLL_MS = 5 * 60_000;
const UPD_MIN_GAP_MS = 60_000;
/** How often the counters are re-checked for changes made outside the App (AI-153). */
const STATE_POLL_MS = 30_000;

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
  private stateTimer?: ReturnType<typeof setInterval>;
  private updDebounce?: ReturnType<typeof setTimeout>;
  private updAt = 0;
  private updRetry?: ReturnType<typeof setTimeout>;
  private updFailures = 0;
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
    // AI-153 — skipped while hidden, like the update poll: nobody is reading the counters then,
    // and the focus check below catches up the moment they are.
    this.stateTimer = setInterval(() => {
      const w = BrowserWindow.fromWebContents(this.wc);
      if (w && !w.isDestroyed() && w.isVisible() && !w.isMinimized()) this.refreshStateIfChanged();
    }, STATE_POLL_MS);
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
      /* WATCH THE FOLDER, NOT THE FILE. /aios:update writes the tracker with `sed -i`, which
         replaces the file with a new one. A watch on the file follows the OLD file: it fires
         once and then never again, so the second /aios:update in one App session was invisible.
         The header sat on "update available" until the 60s focus re-check or the 5-minute poll
         (reported 2026-09-22; measured: three `sed -i` writes, one event). A watch on the
         folder sees the name come back each time. Non-recursive, filtered to the one name, so
         nothing else in the framework root triggers a network check. `filename` can be null on
         some platforms; then we cannot rule the tracker out, and the check is debounced anyway. */
      try {
        this.watchers.push(fs.watch(r, (_e, name) => {
          if (name !== null && name !== undefined && String(name) !== '.aios-update') return;
          this.scheduleRefresh();
          this.updateStatusSoon();   // debounced: one sed -i fires several events
        }));
      } catch { /* framework root unreadable — the poll and focus re-check still cover it */ }
    }
  }

  dispose(): void {
    this.attention.dispose();
    if (this.timer) clearInterval(this.timer);
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.updTimer) clearInterval(this.updTimer);
    if (this.stateTimer) clearInterval(this.stateTimer);   // a timer outliving its window is a leak
    if (this.updRetry) clearTimeout(this.updRetry);
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

  /* AI-153, THE CLASS. The panel's counters are a PUSHED snapshot: the renderer draws whatever
     the last postState said. Watched sources re-push themselves; the App's own mutating handlers
     push (pulseState.test enforces that). What neither covers is a source that changes OUTSIDE
     the App and is not watched — agents/, skills/ and plugins/ commands (a sync, or a session
     writing one), .glass/state.json (Glass shares it), and the nudge, which depends on the clock.
     Those stayed stale until something unrelated happened to trigger a push.
     The fix is a CHANGE-GATED check, deliberately not more watchers: every 30s and on window
     focus, recompute the payload and post only if it differs from what was last sent. An
     unchanged window gets zero renderer work, and a timer cannot feed itself — a watcher on a
     path the App writes can, and that loop is the one shape of bug this ship must not add. */
  private lastState = '';

  private stateSnapshot(): Record<string, unknown> {
    return {
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
      learnings: aios.recentLearnings(),
      nudge: aios.shellSettings().showNudges
        ? (() => { const now = new Date(); return aios.nudgeState(now.getHours(), now.getDay(), aios.listRunningAgents().length); })()
        : null,
      outputs: aios.recentOutputs(),
      reports: aios.recentReports(),
    };
  }

  /** Unconditional — every existing caller keeps exactly the behaviour it had (a renderer that
   *  just reloaded needs the state whether or not it changed). It also records what was sent. */
  postState(): void {
    const snap = this.stateSnapshot();
    this.lastState = JSON.stringify(snap);
    this.post(snap);
  }

  /** The gated check: post only when something the panel shows has actually changed. */
  refreshStateIfChanged(): void {
    let snap: Record<string, unknown>;
    try { snap = this.stateSnapshot(); } catch { return; }
    const json = JSON.stringify(snap);
    if (json === this.lastState) return;
    this.lastState = json;
    this.post(snap);
  }

  /** Dock badge + banner for sessions blocked on the operator (#22). Driven by the same
   *  2s poll that already lists the sessions, so it costs one function call, not a timer. */
  private attention = new Attention({
    /* macOS refused every banner. Point at the one place that can fix it — the operator's own
       System Settings — rather than leaving the setting looking broken. */
    notifyBlocked: () => this.intent('toast', { text: t('notify.osBlocked') }),
    /* WINDOWS ONLY, guarded by PLATFORM rather than by feature-detection: `setOverlayIcon` is on
       the BrowserWindow type everywhere and is documented Windows-only, so a truthy check would
       say yes on macOS and then do nothing — a call that reads as wired and is not.
       A failed draw leaves the overlay CLEARED rather than stale: no signal beats a wrong count. */
    setOverlay: (text, description) => {
      if (process.platform !== 'win32') return;
      const w = BrowserWindow.fromWebContents(this.wc);
      if (!w || w.isDestroyed()) return;
      if (!text) { try { w.setOverlayIcon(null, ''); } catch { /* unsupported */ } return; }
      void this.drawOverlay(text).then((dataUrl) => {
        if (!dataUrl || w.isDestroyed()) return;
        try { w.setOverlayIcon(nativeImage.createFromDataURL(dataUrl), description); }
        catch { /* unsupported */ }
      }).catch(() => { /* leave it cleared */ });
    },
    flash: (on) => {
      if (process.platform !== 'win32') return;
      const w = BrowserWindow.fromWebContents(this.wc);
      if (!w || w.isDestroyed()) return;
      try { w.flashFrame(on); } catch { /* unsupported */ }
    },
    isFocused: () => {
      const w = BrowserWindow.fromWebContents(this.wc);
      return !!w && !w.isDestroyed() && w.isFocused();
    },
    reveal: (target) => {
      const w = BrowserWindow.fromWebContents(this.wc);
      if (w && !w.isDestroyed()) { if (w.isMinimized()) w.restore(); w.show(); w.focus(); }
      /* `id` is what `aios.revealAgent` sends too — one payload shape for one renderer handler. */
      this.intent('focusTerminal', { name: target.name, id: target.sessionId ?? '' });
    },
  });

  /**
   * A 32px taskbar overlay glyph carrying `text`, as a data URL — drawn in the RENDERER because
   * main has no 2D canvas, and a numbered 16px badge is not something to hand-encode as a PNG.
   *
   * Bounded by a timeout. A renderer that never answers must not leave an overlay update pending
   * forever, and a missed overlay is a far smaller failure than a stuck one. It reads the theme's
   * own attention colour, so the taskbar agrees with the dot in the panel instead of inventing a
   * second blue.
   */
  private drawOverlay(text: string): Promise<string | null> {
    const label = JSON.stringify(text);
    const size = text.length > 1 ? 17 : 21;
    const js = [
      '(() => { try {',
      '  const c = document.createElement("canvas"); c.width = 32; c.height = 32;',
      '  const x = c.getContext("2d");',
      '  const css = getComputedStyle(document.documentElement);',
      '  x.fillStyle = (css.getPropertyValue("--st-input") || "#6cb0ff").trim();',
      '  x.beginPath(); x.arc(16, 16, 16, 0, Math.PI * 2); x.fill();',
      '  x.fillStyle = "#fff";',
      '  x.font = "600 ' + size + 'px -apple-system, Segoe UI, sans-serif";',
      '  x.textAlign = "center"; x.textBaseline = "middle";',
      '  x.fillText(' + label + ', 16, 17);',
      '  return c.toDataURL("image/png");',
      '} catch { return null; } })()',
    ].join('\n');
    return Promise.race([
      this.wc.executeJavaScript(js).then((v) => (typeof v === 'string' ? v : null)),
      new Promise<string | null>((r) => setTimeout(() => r(null), 2000)),
    ]).catch(() => null);
  }

  postRunning(): void {
    const running = aios.listRunningAgents();
    this.attention.tick(running, aios.shellSettings().attention);
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
      running: running.map((a) => ({ name: a.name, pid: a.pid, id: a.sessionId, key: sessionKey(a), status: a.status, proj: projOf(a.cwd), startedAt: a.startedAt, updatedAt: a.updatedAt, mem: mem[a.pid] })),
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
    void aios.checkForUpdates().then((state) => {
      const framework = aios.readFrameworkStatus() ?? null;
      /* Told to the renderer rather than inferred there: only this side knows whether a retry was
         armed, and a header that says "retrying…" must be true — the rule for which unknowns are
         retried lives here, and a second copy in the renderer is how the two would drift. */
      const retrying = state === 'unknown' && aios.frameworkCheckable(framework);
      this.post({ type: 'updateStatus', state, framework, retrying });
      /* A FAILED CHECK RETRIES ITSELF. Operator-reported 2026-09-22: Wi-Fi off showed "offline",
         Wi-Fi back on showed "can't check" — and it stayed that way until the App was restarted.
         The reconnect DID trigger a check, at the one moment it is least likely to succeed: the
         `online` event fires when the interface comes up, before DNS is ready. That failure then
         had nothing behind it but the 5-minute poll, and focus only re-checks after 60s — so a
         header saying "can't check" looked permanent.
         Only the unknowns a retry can fix: a tracker exists, so the network call is what failed.
         (No tracker at all is a different state and retrying it would change nothing.) Backoff
         from 5s, capped at the regular poll, and stopped the moment an answer arrives — so this
         adds work only while something is genuinely wrong, never on a healthy window. */
      if (this.updRetry) { clearTimeout(this.updRetry); this.updRetry = undefined; }
      if (retrying) {
        this.updFailures += 1;
        this.updRetry = setTimeout(() => {
          this.updRetry = undefined;
          const w = BrowserWindow.fromWebContents(this.wc);
          if (w && !w.isDestroyed()) this.postUpdateStatus();
        }, aios.updateRetryDelay(this.updFailures, UPD_POLL_MS));
      } else {
        this.updFailures = 0;
      }
    });
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
      /* AN EXPLICIT RE-CHECK STARTS THE BACKOFF OVER. It arrives when the network comes back (the
         renderer's `online` event) and when the operator clicks — both moments when "the last ten
         attempts failed" is no longer evidence of anything. Without this, being offline for a
         couple of minutes grew the backoff to 80s+, the reconnect check failed once (DNS not ready
         yet), and the next retry was minutes away: "can't check" until clicked. Reproduced with the
         real checker before this line existed — network up at 3s, no answer at 25s. */
      case 'recheck':
        this.updFailures = 0;
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
      /* Each of these carries an optional sessionId as args[1]. Two live sessions can share a
         name, so a name alone cannot say which was meant — the renderer prefers the id, and the
         destructive ones (close · interrupt · send) REFUSE an ambiguous name rather than act on
         whichever pane came first. */
      case 'aios.revealAgent': this.intent('focusByName', { name: String(args[0] ?? ''), id: String(args[1] ?? '') }); return;
      case 'aios.closeAgent': this.intent('closeByName', { name: String(args[0] ?? ''), id: String(args[1] ?? '') }); return;
      case 'aios.closeSessionAgent': this.intent('sendByName', { name: String(args[0] ?? ''), id: String(args[1] ?? ''), text: '/aios:close-session' }); return;
      case 'aios.interruptAgent': this.intent('escByName', { name: String(args[0] ?? ''), id: String(args[1] ?? '') }); return;
      case 'aios.openLearning': this.intent('openFile', { path: String(args[0] ?? ''), mode: 'markdown', line: Number(args[1] ?? 0) }); return;
      case 'aios.openOutput': this.intent('openFile', { path: String(args[0] ?? ''), mode: 'auto' }); return;
      default:
        this.intent('toast', { text: `${command} — coming to the shell soon (use the extension meanwhile)` });
    }
  }
}
