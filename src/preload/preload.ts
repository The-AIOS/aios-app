import { contextBridge, ipcRenderer, webUtils } from 'electron';
// types only: nothing from core is bundled into the preload
import type { ChatStatus } from '../core/chatEvents';
import type { SlashCommand } from '../core/slashCommands';
import type { ChatItem } from '../core/transcriptChat';
import type { TuiPromptKind, TuiOption } from '../core/tuiPrompt';

/** One row of the Connectors card. Mirrors main/connectors.ts ConnectorRow. */
type ConnRow = {
  id: string; service: string; value: string;
  state: 'connected' | 'drift' | 'needs-key' | 'needs-install' | 'available';
  detail: string[]; connect: 'one-click' | 'needs-key' | 'guided';
  canConnect: boolean; hint?: string; pending: string[]; custom: boolean; tracked: boolean; docs?: string;
};
type ConnResult = { ok: boolean; error?: string; row?: ConnRow };

/** Events on 'chatSkin:event'. `reset` empties the view (before a backfill or on a file change);
 *  `items` upserts by uuid; `prompt` with kind null means the terminal dialog is gone. A prompt that
 *  carries `options` (and usually `question`) was read well enough to draw as buttons: each option has the
 *  `key` that picks it, which the card writes to the pty ONLY on the operator's click or key. `refresh`
 *  marks the same dialog with its cursor moved (new `selected`/`key`s), not a new dialog. `stream` is the
 *  reply being written, read off the screen (core/screenStream): a string is the preview so far, null is
 *  "nothing is being written now" (keep the preview frozen), and `adopt` names the transcript item that IS
 *  the previewed message (it arrives in the next `items` event and takes the preview's place). */
type ChatSkinEvent = { paneId: number; sid?: string } & (
  | { type: 'reset' }
  | { type: 'span'; earlier: boolean }
  | { type: 'earlier'; items: ChatItem[]; more: boolean }
  | { type: 'items'; items: ChatItem[] }
  | { type: 'turn'; open: boolean }
  | { type: 'usage'; contextTokens?: number; model?: string }
  | { type: 'prompt'; kind: TuiPromptKind | null; hint?: string; question?: string; options?: TuiOption[]; refresh?: boolean }
  | { type: 'stream'; text: string; anchor: string; headCut: boolean }
  | { type: 'stream'; text: null; adopt?: string }
  | { type: 'missing' }
  | { type: 'error'; code: string }
);


/** The renderer's window into the shell — PTY now; pickers/watchers/state next. */
contextBridge.exposeInMainWorld('glassShell', {
  /* The real filesystem path of a File from an OS drag. Electron REMOVED File.path in v32,
     so this is the only way to resolve a Finder drop — without it, external drags look
     like they work and then do nothing. */
  pathForFile: (f: File): string => { try { return webUtils.getPathForFile(f); } catch { return ''; } },
  /* The drop IS the consent to read those files. Takes File objects (a page only gets real ones from
     a user's drag or a file picker) and sends their paths; a string path from the page is never
     accepted as a grant. */
  grantDroppedFiles: (files: File[]): Promise<boolean> => {
    const paths = (files || []).map((f) => { try { return webUtils.getPathForFile(f); } catch { return ''; } }).filter(Boolean);
    return ipcRenderer.invoke('fs:grantDropped', paths);
  },
  addFolderPath: (p: string): Promise<string | { refused: string; path: string } | null> => ipcRenderer.invoke('fs:addFolderPath', p),
  ptySpawn: (opts: { cols: number; rows: number; cmd?: string; cwd?: string; name?: string; noProfile?: boolean }): Promise<number> => ipcRenderer.invoke('pty:spawn', opts),
  /* App self-update. `updater.ts` has emitted on `shell:updater` since it was written and
     NOTHING listened — its own comment called the renderer surface a "future" one. These
     three lines are that surface's whole cost. */
  onUpdater: (cb: (m: { channel: string; payload?: unknown }) => void): void => {
    ipcRenderer.on('shell:updater', (_e, m) => cb(m));
  },
  updaterCheck: (): Promise<unknown> => ipcRenderer.invoke('updater:check'),
  updaterInstall: (): Promise<unknown> => ipcRenderer.invoke('updater:quitAndInstall'),
  /* CHAT SKIN — a chat view over a terminal tab. The tab's pty stays the only session; main follows
     its transcript file live and reports what the TUI is waiting on. `paneId` is the pty id.
     chatStatus is the usage bar. The statusline payload is global (the last one ANY session wrote), so the tab passes its own
     session id: model/effort/context come back only when the payload is that session's (`sessionMatch`), the account's
     5-hour/weekly numbers always. */
  chatSkinWatch: (paneId: number, sessionId: string | null): Promise<{ ok: true; file: string } | { ok: false; error: string }> => ipcRenderer.invoke('chatSkin:watch', paneId, sessionId),
  chatSkinUnwatch: (paneId: number): Promise<void> => ipcRenderer.invoke('chatSkin:unwatch', paneId),
  /** Ask for the window of transcript lines just above what the view has (answered as an `earlier` event; ok:false = nothing to answer with). */
  chatSkinEarlier: (paneId: number): Promise<{ ok: boolean }> => ipcRenderer.invoke('chatSkin:earlier', paneId),
  /** What the pane's terminal shows right now (plain text): the dialog detector reads screens, not the raw stream. */
  chatSkinScreen: (paneId: number, text: string): void => { ipcRenderer.send('chatSkin:screen', paneId, text); },
  onChatSkinEvent: (cb: (ev: ChatSkinEvent) => void): void => { ipcRenderer.on('chatSkin:event', (_e, ev) => cb(ev)); },
  chatStatus: (sessionId: string | null): Promise<ChatStatus> => ipcRenderer.invoke('chat:status', sessionId),
  /* The chat composer's slash popup: the rows for what is in the box (built-in, project, user and plugin commands, ranked), [] for no popup. */
  slashCommands: (cwd: string | null, text: string): Promise<SlashCommand[]> => ipcRenderer.invoke('slashCommands:list', cwd, text),
  /* An image pasted or dragged from a browser has no path: main saves the bytes to a temp file it names and returns that
     path (null when refused: not a png/jpeg/gif/webp, empty, or too big). The renderer inserts the path in the box. */
  chatSavePastedImage: (bytes: ArrayBuffer, mime: string): Promise<string | null> => ipcRenderer.invoke('chatFiles:savePastedImage', bytes, mime),
  ptyWrite: (id: number, data: string) => ipcRenderer.send('pty:write', { id, data }),
  programStatus: (sessionId: string, data: string, at: number) => ipcRenderer.send('pty:programStatus', { sessionId, data, at }),
  paneSessions: (ids: string[]) => ipcRenderer.send('panes:sessions', ids),
  speakable: (sessionId: string): Promise<{ text: string; lang: string }> => ipcRenderer.invoke('session:speakable', sessionId),
  copyLastAnswer: (sessionId: string): Promise<number> => ipcRenderer.invoke('session:copyLastAnswer', sessionId),
  sessionIsLive: (sessionId: string): Promise<boolean> => ipcRenderer.invoke('session:isLive', sessionId),
  ptyResize: (id: number, cols: number, rows: number) => ipcRenderer.send('pty:resize', { id, cols, rows }),
  ptyKill: (id: number) => ipcRenderer.send('pty:kill', { id }),
  onPtyData: (cb: (m: { id: number; data: string }) => void) => ipcRenderer.on('pty:data', (_e, m) => cb(m)),
  onPtyExit: (cb: (m: { id: number; exitCode: number }) => void) => ipcRenderer.on('pty:exit', (_e, m) => cb(m)),
  // panel bridge: panel iframe ⇄ main PanelHost
  panelSend: (msg: unknown) => ipcRenderer.send('panel:msg', msg),
  onPanelPost: (cb: (msg: unknown) => void) => ipcRenderer.on('panel:post', (_e, m) => cb(m)),
  // shell intents: main → renderer (open terminals, files, ask modal, toasts)
  onIntent: (cb: (m: { kind: string; [k: string]: unknown }) => void) => ipcRenderer.on('shell:intent', (_e, m) => cb(m)),
  // vault-scoped fs for explorer + viewers
  fsList: (rel: string): Promise<{ name: string; dir: boolean; path: string; mtime: number }[]> => ipcRenderer.invoke('fs:list', rel),
  // AI-58: explorer sort prefs — per-folder overrides + master default (.glass/state.json)
  sortState: (): Promise<{ master: string; overrides: Record<string, string> }> => ipcRenderer.invoke('fs:sortState'),
  setSort: (folder: string, mode: string): Promise<{ master: string; overrides: Record<string, string> }> => ipcRenderer.invoke('fs:setSort', folder, mode),
  setMasterSort: (mode: string): Promise<{ master: string; overrides: Record<string, string> }> => ipcRenderer.invoke('fs:setMasterSort', mode),
  ptyCwd: (id: number): Promise<string | null> => ipcRenderer.invoke('pty:cwd', id),
  fsRead: (p: string): Promise<{ path: string; content: string | null; unreadable?: 'binary' | 'large'; size?: number } | null> => ipcRenderer.invoke('fs:read', p),
  resolveNote: (name: string): Promise<string | null> => ipcRenderer.invoke('fs:resolveNote', name),
  resolveFile: (cand: string, base?: string): Promise<string | null> => ipcRenderer.invoke('fs:resolveFile', cand, base),
  dirtyLines: (abs: string): Promise<Array<[number, number]>> => ipcRenderer.invoke('fs:dirtyLines', abs),
  resolveFiles: (cands: string[], base?: string): Promise<{ open: Record<string, string>; reveal: Record<string, string> }> => ipcRenderer.invoke('fs:resolveFiles', cands, base),
  /* The chat's resolver: like resolveFiles (same cleaning, one batch) but inside the allowed roots only, folders count,
     and each hit says which it is. Kept apart so the terminal's {open, reveal} reply never changes shape. */
  resolvePaths: (cands: string[], base?: string): Promise<Record<string, { abs: string; dir: boolean }>> => ipcRenderer.invoke('fs:resolvePaths', cands, base),
  /* One flag only, and a diagnostic one: AIOS_NO_WEBGL disables the GPU renderer so a
     rendering artifact can be attributed or ruled out. Deliberately not the whole env. */
  env: { AIOS_NO_WEBGL: process.env.AIOS_NO_WEBGL || '' },
  /* The host platform, so the renderer can quote pane commands for the RIGHT shell (PowerShell
     on win32 doubles a single-quote, POSIX shells escape it) and render/compare Windows paths.
     A plain string ('win32' | 'darwin' | 'linux'); the renderer has no other way to know. */
  platform: process.platform,
  /* The installed version. Sits beside `platform` in spirit — a fact about the running app that
     the renderer has no other way to learn, and that it needs at launch to answer "did we just
     update?" without asking the network. */
  appVersion: (): Promise<string> => ipcRenderer.invoke('shell:appVersion'),
  claudeStores: (): Promise<Record<string, string>> => ipcRenderer.invoke('claude:stores'),
  claudeSetKeys: (): Promise<Record<string, boolean>> => ipcRenderer.invoke('claude:setKeys'),
  updaterCheckNow: (): Promise<{ ok: boolean; version?: string; current: string; message?: string }> => ipcRenderer.invoke('updater:checkNow'),
  onClaudeConfigChanged: (cb: (c: unknown) => void) => ipcRenderer.on('shell:claudeConfigChanged', (_e, c) => cb(c)),
  // AI-132 keep-awake: main owns the decision and the blocker; the renderer shows state + sends intent.
  tabMenu: (items: { label: string; value: string }[]): Promise<string | null> => ipcRenderer.invoke('tab:menu', items),
  caffeinateState: (): Promise<unknown> => ipcRenderer.invoke('caffeinate:state'),
  caffeinateToggle: (): Promise<unknown> => ipcRenderer.invoke('caffeinate:toggle'),
  caffeinateLid: (on: boolean, prompt: string): Promise<unknown> => ipcRenderer.invoke('caffeinate:lid', on, prompt),
  caffeinateLidRemove: (prompt: string): Promise<unknown> => ipcRenderer.invoke('caffeinate:lidRemove', prompt),
  onCaffeinate: (cb: (s: unknown) => void) => ipcRenderer.on('shell:caffeinate', (_e, s) => cb(s)),
  menuShortcuts: (): Promise<Array<{ group: string; label: string; accel: string }>> => ipcRenderer.invoke('menu:shortcuts'),
  locateSessions: (ids: string[]): Promise<Record<string, { exists: boolean; live: boolean }>> => ipcRenderer.invoke('sessions:locate', ids),
  resumableSessions: (): Promise<{ items: Array<{ id: string; name: string; proj: string; at: number }>; total: number; named: number; unnamed: number }> =>
    ipcRenderer.invoke('sessions:resumable'),
  ptyRun: (id: number, cmd: string): Promise<boolean> => ipcRenderer.invoke('pty:run', { id, cmd }),
  /* AI-66 pt3 — the renderer tells the bus whether a send actually landed, so a request that
     cannot be delivered here is retired at once instead of waiting out a verification window. */
  busSendResult: (name: string, ok: boolean, reason: string): void => { ipcRenderer.send('bus:sendResult', { name, ok, reason }); },
  /* #81 — the operator is writing in this session's pane: the bus holds its message (commandBus). */
  busComposing: (name: string, composing: boolean): void => { ipcRenderer.send('bus:composing', { name, composing }); },
  vaultRoot: (): Promise<string | null> => ipcRenderer.invoke('shell:vaultRoot'),
  fsWrite: (p: string, content: string): Promise<boolean> => ipcRenderer.invoke('fs:write', p, content),
  setupCheck: (): Promise<{ id: string; label: string; status: 'pass' | 'warn' | 'fail'; message: string; repairHint?: string; repairCmd?: string; canRepair: boolean }[]> => ipcRenderer.invoke('setup:check'),
  // doctor: run a check's headless repair, then re-run the same check as proof
  doctorRepair: (id: string): Promise<{ id: string; label: string; status: 'pass' | 'warn' | 'fail'; message: string; repairHint?: string; repairCmd?: string; canRepair: boolean } | null> => ipcRenderer.invoke('doctor:repair', id),
  /* Finish setup: skills → plugin → spawn → hooks, run by the App and re-checked; stops at the first
     that does not come back green (`stoppedAt`), leaving the rest as they were. */
  finishSetup: (): Promise<{ results: { id: string; label: string; status: 'pass' | 'warn' | 'fail'; message: string; repairHint?: string; canRepair: boolean }[]; ok: boolean; stoppedAt?: string; reason?: string }> => ipcRenderer.invoke('doctor:finishSetup'),
  // the wiring still missing, each with ONE pasteable line (no `!`, no wrap) — the Next steps fallback
  wiringLeft: (): Promise<{ id: string; label: string; message: string; cmd?: string }[]> => ipcRenderer.invoke('doctor:wiringLeft'),
  // the Health card's rows (framework · vault · account · skills · claude · gh)
  /* "Having issues?" — the triage entry. Returns the next ACTION per failing check (run a
     command / open the vendor page / send a report), never a screen of findings. */
  doctorTriage: (): Promise<{
    items: { checkId: string; kind: 'run' | 'open' | 'support'; cmd?: string; url?: string; via?: string; message?: string }[];
    supportOnly: boolean; report: string;
  }> => ipcRenderer.invoke('doctor:triage'),
  doctorHealth: (): Promise<{ id: string; label: string; status: 'pass' | 'warn' | 'fail'; message: string; repairHint?: string; repairCmd?: string; canRepair: boolean }[]> => ipcRenderer.invoke('doctor:health'),
  routineHealth: (): Promise<Array<{ name: string; status: string; state?: string; detail?: string; writtenAt?: number; validUntil?: number; why?: string }>> => ipcRenderer.invoke('health:routines'),
  // Connectors card: list / connect / disconnect / add one the framework does not bundle
  connectorsList: (): Promise<{ rows: ConnRow[]; foreign: { id: string }[]; other: { id: string; custom: boolean; tracked: boolean }[] }> => ipcRenderer.invoke('connectors:list'),
  connectorsConnect: (id: string, answers?: Record<string, string>): Promise<ConnResult> => ipcRenderer.invoke('connectors:connect', id, answers),
  connectorsDisconnect: (id: string): Promise<ConnResult> => ipcRenderer.invoke('connectors:disconnect', id),
  connectorsFix: (id: string): Promise<ConnResult> => ipcRenderer.invoke('connectors:fix', id),
  connectorsDelete: (id: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('connectors:delete', id),
  connectorsAddCustom: (input: string, service?: string): Promise<ConnResult & { id?: string }> => ipcRenderer.invoke('connectors:addCustom', input, service),
  // the Onboarding flow: sequenced onboarding stepper (steps + which one is active)
  onboardingState: (): Promise<{ steps: { id: string; done: boolean; state: 'done' | 'active' | 'locked'; required: string[]; optional: string[]; skipped?: boolean; checks: { id: string; label: string; status: 'pass' | 'warn' | 'fail'; message: string; repairHint?: string; repairCmd?: string; canRepair: boolean }[] }[]; current: number; finishPending?: string[] }> => ipcRenderer.invoke('onboarding:state'),
  onboardingSkip: (id: string): Promise<unknown> => ipcRenderer.invoke('onboarding:skip', id),
  // PAT lane of the GitHub step — stored via git's credential helper, never echoed
  onboardingStorePat: (pat: string): Promise<'verified' | 'unverified' | 'failed'> => ipcRenderer.invoke('onboarding:storePat', pat),
  // starter packs (the Onboarding persona step): list + apply (seeds .glass/state.json)
  starterPacks: (): Promise<{ id: string; tasks: string[]; agents: string[] }[]> => ipcRenderer.invoke('starter:packs'),
  starterApply: (id: string): Promise<{ id: string; tasks: number; agents: string[] } | null> => ipcRenderer.invoke('starter:apply', id),
  // Agent/Skill Designer: compose file + registry entry for live preview + save
  designerCatalog: (kind: string): Promise<{ name: string; description: string; group: string; path: string; custom: boolean }[]> => ipcRenderer.invoke('designer:catalog', kind),
  taskHandoff: (prompt: string, name?: string): Promise<string | { error: string }> => ipcRenderer.invoke('task:handoff', { prompt, name }),
  askName: (intent: string, panes?: string[]): Promise<string> => ipcRenderer.invoke('ask:name', intent, panes),
  askUnique: (name: string, panes?: string[]): Promise<string> => ipcRenderer.invoke('ask:unique', name, panes),
  designerHandoff: (req: { kind: string; fields: { name: string; description: string; keywords?: string; tier?: string; body: string }; mode: string; targetPath?: string }): Promise<{ file: string; prompt: string } | { error: string } | null> => ipcRenderer.invoke('designer:handoff', req),
  designerRead: (relPath: string): Promise<{ description: string; body: string } | null> => ipcRenderer.invoke('designer:read', relPath),
  designerBrief: (req: { kind: string; fields: { name: string; description: string; keywords?: string; tier?: string; body: string }; mode: string; templatePath?: string; targetPath?: string }): Promise<string> => ipcRenderer.invoke('designer:brief', req),
  shellConfig: (): Promise<{ claudeCmd: string; showHints: boolean; showNudges: boolean }> => ipcRenderer.invoke('shell:config'),
  setSetting: (key: string, value: unknown): Promise<{ claudeCmd: string; showHints: boolean; showNudges: boolean }> => ipcRenderer.invoke('shell:setSetting', key, value),
  claudeConfig: (): Promise<{ account: string; model: string; mode: string; remoteControl: boolean; autoUpdates: boolean; outputStyle: string; reduceMotion: boolean; switchModelsOnFlag: boolean; claudeInChrome: boolean; copyOnSelect: boolean; diffPanel: boolean; agentPushNotif: boolean; inputNeededNotif: boolean; awaySummary: boolean; autoCompact: boolean }> => ipcRenderer.invoke('claude:config'),
  claudeSet: (key: string, value: unknown): Promise<{ account: string; model: string; mode: string; remoteControl: boolean; autoUpdates: boolean; outputStyle: string; reduceMotion: boolean; switchModelsOnFlag: boolean; claudeInChrome: boolean; copyOnSelect: boolean; diffPanel: boolean; agentPushNotif: boolean; inputNeededNotif: boolean; awaySummary: boolean; autoCompact: boolean }> => ipcRenderer.invoke('claude:set', key, value),
  outputStyles: (): Promise<string[]> => ipcRenderer.invoke('claude:outputStyles'),
  modelOptions: (): Promise<{ label: string; value: string }[]> => ipcRenderer.invoke('claude:modelOptions'),
  recommendedModel: (): Promise<{ label: string; value: string }> => ipcRenderer.invoke('claude:recommendedModel'),
  rankPinnedModel: (pinned: string): Promise<string> => ipcRenderer.invoke('claude:rankPinnedModel', pinned),
  phase1Script: (): Promise<string> => ipcRenderer.invoke('aios:phase1'),
  trustDir: (dir: string): Promise<boolean> => ipcRenderer.invoke('aios:trustDir', dir),
  prepareSetupCwd: (): Promise<string> => ipcRenderer.invoke('aios:prepareSetupCwd'),
  bannerScript: (m: { ok: string; okSub: string; fail: string; failSub: string }): Promise<string> => ipcRenderer.invoke('aios:banner', m),
  readiness: (): Promise<{ claude: boolean; framework: boolean; vault: boolean; signedIn: boolean; ready: boolean }> => ipcRenderer.invoke('aios:readiness'),
  addFrequent: (task: { label: string; kind: string; target: string; hint?: string; assignment?: string }): Promise<unknown[]> => ipcRenderer.invoke('aios:addFrequent', task),
  removeFrequent: (id: string): Promise<unknown[]> => ipcRenderer.invoke('aios:removeFrequent', id),
  setAutoUpdates: (on: boolean): Promise<boolean> => ipcRenderer.invoke('shell:setAutoUpdates', on),
  permissionModes: (): Promise<string[]> => ipcRenderer.invoke('claude:permissionModes'),
  frameworkPath: (): Promise<{ value: string; resolved: string; source: string }> => ipcRenderer.invoke('shell:frameworkPath'),
  setFrameworkPath: (v: string): Promise<{ value: string; resolved: string; source: string }> => ipcRenderer.invoke('shell:setFrameworkPath', v),
  fsRoots: (): Promise<{ framework: string | null; vault: string | null; workspace: { path: string; name: string }[] }> => ipcRenderer.invoke('fs:roots'),
  addFolder: (): Promise<string | { refused: string; path: string } | null> => ipcRenderer.invoke('fs:addFolder'),
  removeFolder: (p: string): Promise<boolean> => ipcRenderer.invoke('fs:removeFolder', p),
  aiosLists: (): Promise<{ agents: unknown[]; commands: unknown[]; skills: unknown[]; frequent: unknown[]; running: unknown[]; suggestions: unknown[] }> => ipcRenderer.invoke('aios:lists'),
  fsIndex: (): Promise<{ name: string; path: string; root: string }[]> => ipcRenderer.invoke('fs:index'),
  aiosPlugins: (): Promise<{ catalog: unknown[]; installed: unknown[]; marketplaces: unknown[] }> => ipcRenderer.invoke('aios:plugins'),
  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke('shell:openExternal', url),
  sessionSignal: (pid: number, sig: string): Promise<boolean> => ipcRenderer.invoke('session:signal', { pid, sig }),
  notesGet: (name: string): Promise<{ t: string; ts: number }[]> => ipcRenderer.invoke('notes:get', name),
  notesCounts: (): Promise<Record<string, number>> => ipcRenderer.invoke('notes:counts'),
  openDevTools: (): Promise<boolean> => ipcRenderer.invoke('shell:devtools'),
  /** Pane handles → the live session running under each pane's pty. Exact identity, where a
   *  name cannot be: two live sessions may share a name. */
  sessionUnder: (paneIds: number[]): Promise<Record<number, { name: string; id: string; pid: number }>> =>
    ipcRenderer.invoke('session:under', paneIds),
  setPrimary: (name: string): Promise<{ ok: boolean; name: string }> => ipcRenderer.invoke('shell:setPrimary', name),
  accountsList: (): Promise<{ email: string; note: string; current: boolean }[]> => ipcRenderer.invoke('accounts:list'),
  accountsSwap: (email: string): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('accounts:swap', email),
  notesAdd: (name: string, note: string): Promise<{ t: string; ts: number }[]> => ipcRenderer.invoke('notes:add', name, note),
  notesDel: (name: string, index: number): Promise<{ t: string; ts: number }[]> => ipcRenderer.invoke('notes:del', name, index),
  fsGit: (): Promise<{ files: Record<string, string>; dirty: string[]; repos: string[]; slow: string[] }> => ipcRenderer.invoke('fs:git'),
  revealInOS: (p: string): Promise<boolean> => ipcRenderer.invoke('shell:reveal', p),
  /* Open a local file OUTSIDE the app — the system's default handler, never the in-app browser
     pane. Takes a PATH, not a URL: main validates it against the allowed roots and builds the
     file:// URL itself, so the renderer cannot name an arbitrary target. Resolves false when the
     path is refused or missing, which the caller must actually report. */
  openPathExternal: (p: string): Promise<boolean> => ipcRenderer.invoke('shell:openPathExternal', p),
  setZoom: (factor: number): Promise<number> => ipcRenderer.invoke('shell:zoom', factor),
  readText: (): Promise<string> => ipcRenderer.invoke('shell:readText'),
  copyText: (t: string): Promise<boolean> => ipcRenderer.invoke('shell:copyText', t),
  reportSnapshot: (name: string, text: string): Promise<string> => ipcRenderer.invoke('feedback:snapshot', name, text),
  copyPlainText: (t: string, cols: number): Promise<boolean> => ipcRenderer.invoke('shell:copyPlainText', t, cols),
  htmlToPng: (p: string): Promise<{ out: string; w: number; h: number } | null> => ipcRenderer.invoke('html:toPng', p),
  onFsEvent: (cb: (m: { dirs: string[] }) => void) => ipcRenderer.on('shell:fsEvent', (_e, m) => cb(m)),
  onRootsChanged: (cb: (m: { framework: string; vault: string }) => void) => ipcRenderer.on('shell:rootsChanged', (_e, m) => cb(m)),
});
