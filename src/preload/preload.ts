import { contextBridge, ipcRenderer, webUtils } from 'electron';

/** The renderer's window into the shell — PTY now; pickers/watchers/state next. */
contextBridge.exposeInMainWorld('glassShell', {
  /* The real filesystem path of a File from an OS drag. Electron REMOVED File.path in v32,
     so this is the only way to resolve a Finder drop — without it, external drags look
     like they work and then do nothing. */
  pathForFile: (f: File): string => { try { return webUtils.getPathForFile(f); } catch { return ''; } },
  addFolderPath: (p: string): Promise<string | null> => ipcRenderer.invoke('fs:addFolderPath', p),
  ptySpawn: (opts: { cols: number; rows: number; cmd?: string; cwd?: string; name?: string }): Promise<number> => ipcRenderer.invoke('pty:spawn', opts),
  /* App self-update. `updater.ts` has emitted on `shell:updater` since it was written and
     NOTHING listened — its own comment called the renderer surface a "future" one. These
     three lines are that surface's whole cost. */
  onUpdater: (cb: (m: { channel: string; payload?: unknown }) => void): void => {
    ipcRenderer.on('shell:updater', (_e, m) => cb(m));
  },
  updaterCheck: (): Promise<unknown> => ipcRenderer.invoke('updater:check'),
  updaterInstall: (): Promise<unknown> => ipcRenderer.invoke('updater:quitAndInstall'),
  ptyWrite: (id: number, data: string) => ipcRenderer.send('pty:write', { id, data }),
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
  fsRead: (p: string): Promise<{ path: string; content: string } | null> => ipcRenderer.invoke('fs:read', p),
  resolveNote: (name: string): Promise<string | null> => ipcRenderer.invoke('fs:resolveNote', name),
  resolveFile: (cand: string, base?: string): Promise<string | null> => ipcRenderer.invoke('fs:resolveFile', cand, base),
  dirtyLines: (abs: string): Promise<Array<[number, number]>> => ipcRenderer.invoke('fs:dirtyLines', abs),
  resolveFiles: (cands: string[], base?: string): Promise<Record<string, string>> => ipcRenderer.invoke('fs:resolveFiles', cands, base),
  /* One flag only, and a diagnostic one: AIOS_NO_WEBGL disables the GPU renderer so a
     rendering artifact can be attributed or ruled out. Deliberately not the whole env. */
  env: { AIOS_NO_WEBGL: process.env.AIOS_NO_WEBGL || '' },
  menuShortcuts: (): Promise<Array<{ group: string; label: string; accel: string }>> => ipcRenderer.invoke('menu:shortcuts'),
  resumableSessions: (): Promise<{ items: Array<{ id: string; name: string; proj: string; at: number }>; total: number; named: number; unnamed: number }> =>
    ipcRenderer.invoke('sessions:resumable'),
  ptyRun: (id: number, cmd: string): Promise<boolean> => ipcRenderer.invoke('pty:run', { id, cmd }),
  /* AI-66 pt3 — the renderer tells the bus whether a send actually landed, so a request that
     cannot be delivered here is retired at once instead of waiting out a verification window. */
  busSendResult: (name: string, ok: boolean, reason: string): void => { ipcRenderer.send('bus:sendResult', { name, ok, reason }); },
  vaultRoot: (): Promise<string | null> => ipcRenderer.invoke('shell:vaultRoot'),
  fsWrite: (p: string, content: string): Promise<boolean> => ipcRenderer.invoke('fs:write', p, content),
  setupCheck: (): Promise<{ id: string; label: string; status: 'pass' | 'warn' | 'fail'; message: string; repairHint?: string; repairCmd?: string; canRepair: boolean }[]> => ipcRenderer.invoke('setup:check'),
  // doctor: run a check's headless repair, then re-run the same check as proof
  doctorRepair: (id: string): Promise<{ id: string; label: string; status: 'pass' | 'warn' | 'fail'; message: string; repairHint?: string; repairCmd?: string; canRepair: boolean } | null> => ipcRenderer.invoke('doctor:repair', id),
  // the Health card's rows (framework · vault · account · skills · claude · gh)
  doctorHealth: (): Promise<{ id: string; label: string; status: 'pass' | 'warn' | 'fail'; message: string; repairHint?: string; repairCmd?: string; canRepair: boolean }[]> => ipcRenderer.invoke('doctor:health'),
  // the Onboarding flow: sequenced onboarding stepper (steps + which one is active)
  onboardingState: (): Promise<{ steps: { id: string; done: boolean; state: 'done' | 'active' | 'locked'; required: string[]; optional: string[]; checks: { id: string; label: string; status: 'pass' | 'warn' | 'fail'; message: string; repairHint?: string; repairCmd?: string; canRepair: boolean }[] }[]; current: number }> => ipcRenderer.invoke('onboarding:state'),
  // PAT lane of the GitHub step — stored via git's credential helper, never echoed
  onboardingStorePat: (pat: string): Promise<boolean> => ipcRenderer.invoke('onboarding:storePat', pat),
  // starter packs (the Onboarding persona step): list + apply (seeds .glass/state.json)
  starterPacks: (): Promise<{ id: string; tasks: string[]; agents: string[] }[]> => ipcRenderer.invoke('starter:packs'),
  starterApply: (id: string): Promise<{ id: string; tasks: number; agents: string[] } | null> => ipcRenderer.invoke('starter:apply', id),
  // Agent/Skill Designer: compose file + registry entry for live preview + save
  designerCatalog: (kind: string): Promise<{ name: string; description: string; group: string; path: string; custom: boolean }[]> => ipcRenderer.invoke('designer:catalog', kind),
  taskHandoff: (prompt: string, name?: string): Promise<string> => ipcRenderer.invoke('task:handoff', { prompt, name }),
  designerHandoff: (req: { kind: string; fields: { name: string; description: string; keywords?: string; tier?: string; body: string }; mode: string; targetPath?: string }): Promise<{ file: string; prompt: string } | null> => ipcRenderer.invoke('designer:handoff', req),
  designerRead: (relPath: string): Promise<{ description: string; body: string } | null> => ipcRenderer.invoke('designer:read', relPath),
  designerBrief: (req: { kind: string; fields: { name: string; description: string; keywords?: string; tier?: string; body: string }; mode: string; templatePath?: string; targetPath?: string }): Promise<string> => ipcRenderer.invoke('designer:brief', req),
  shellConfig: (): Promise<{ claudeCmd: string; showHints: boolean; showNudges: boolean }> => ipcRenderer.invoke('shell:config'),
  setSetting: (key: string, value: unknown): Promise<{ claudeCmd: string; showHints: boolean; showNudges: boolean }> => ipcRenderer.invoke('shell:setSetting', key, value),
  claudeConfig: (): Promise<{ account: string; model: string; mode: string; remoteControl: boolean; autoUpdates: boolean; outputStyle: string; reduceMotion: boolean; switchModelsOnFlag: boolean; claudeInChrome: boolean; copyOnSelect: boolean; agentPushNotif: boolean; awaySummary: boolean; autoCompact: boolean }> => ipcRenderer.invoke('claude:config'),
  claudeSet: (key: string, value: unknown): Promise<{ account: string; model: string; mode: string; remoteControl: boolean; autoUpdates: boolean; outputStyle: string; reduceMotion: boolean; switchModelsOnFlag: boolean; claudeInChrome: boolean; copyOnSelect: boolean; agentPushNotif: boolean; awaySummary: boolean; autoCompact: boolean }> => ipcRenderer.invoke('claude:set', key, value),
  outputStyles: (): Promise<string[]> => ipcRenderer.invoke('claude:outputStyles'),
  modelOptions: (): Promise<{ label: string; value: string }[]> => ipcRenderer.invoke('claude:modelOptions'),
  phase1Script: (): Promise<string> => ipcRenderer.invoke('aios:phase1'),
  trustDir: (dir: string): Promise<boolean> => ipcRenderer.invoke('aios:trustDir', dir),
  bannerScript: (m: { ok: string; okSub: string; fail: string; failSub: string }): Promise<string> => ipcRenderer.invoke('aios:banner', m),
  readiness: (): Promise<{ claude: boolean; framework: boolean; vault: boolean; signedIn: boolean; ready: boolean }> => ipcRenderer.invoke('aios:readiness'),
  addFrequent: (task: { label: string; kind: string; target: string; hint?: string; assignment?: string }): Promise<unknown[]> => ipcRenderer.invoke('aios:addFrequent', task),
  removeFrequent: (id: string): Promise<unknown[]> => ipcRenderer.invoke('aios:removeFrequent', id),
  setAutoUpdates: (on: boolean): Promise<boolean> => ipcRenderer.invoke('shell:setAutoUpdates', on),
  permissionModes: (): Promise<string[]> => ipcRenderer.invoke('claude:permissionModes'),
  frameworkPath: (): Promise<{ value: string; resolved: string; source: string }> => ipcRenderer.invoke('shell:frameworkPath'),
  setFrameworkPath: (v: string): Promise<{ value: string; resolved: string; source: string }> => ipcRenderer.invoke('shell:setFrameworkPath', v),
  fsRoots: (): Promise<{ framework: string | null; vault: string | null; workspace: { path: string; name: string }[] }> => ipcRenderer.invoke('fs:roots'),
  addFolder: (): Promise<string | null> => ipcRenderer.invoke('fs:addFolder'),
  removeFolder: (p: string): Promise<boolean> => ipcRenderer.invoke('fs:removeFolder', p),
  aiosLists: (): Promise<{ agents: unknown[]; commands: unknown[]; skills: unknown[]; frequent: unknown[]; running: unknown[]; suggestions: unknown[] }> => ipcRenderer.invoke('aios:lists'),
  fsIndex: (): Promise<{ name: string; path: string; root: string }[]> => ipcRenderer.invoke('fs:index'),
  aiosPlugins: (): Promise<{ catalog: unknown[]; installed: unknown[]; marketplaces: unknown[] }> => ipcRenderer.invoke('aios:plugins'),
  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke('shell:openExternal', url),
  sessionSignal: (pid: number, sig: string): Promise<boolean> => ipcRenderer.invoke('session:signal', { pid, sig }),
  notesGet: (name: string): Promise<{ t: string; ts: number }[]> => ipcRenderer.invoke('notes:get', name),
  notesCounts: (): Promise<Record<string, number>> => ipcRenderer.invoke('notes:counts'),
  openDevTools: (): Promise<boolean> => ipcRenderer.invoke('shell:devtools'),
  setPrimary: (name: string): Promise<{ ok: boolean; name: string }> => ipcRenderer.invoke('shell:setPrimary', name),
  accountsList: (): Promise<{ email: string; note: string; current: boolean }[]> => ipcRenderer.invoke('accounts:list'),
  accountsSwap: (email: string): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('accounts:swap', email),
  notesAdd: (name: string, note: string): Promise<{ t: string; ts: number }[]> => ipcRenderer.invoke('notes:add', name, note),
  notesDel: (name: string, index: number): Promise<{ t: string; ts: number }[]> => ipcRenderer.invoke('notes:del', name, index),
  fsGit: (): Promise<{ files: Record<string, string>; dirty: string[]; repos: string[] }> => ipcRenderer.invoke('fs:git'),
  revealInOS: (p: string): Promise<boolean> => ipcRenderer.invoke('shell:reveal', p),
  setZoom: (factor: number): Promise<number> => ipcRenderer.invoke('shell:zoom', factor),
  readText: (): Promise<string> => ipcRenderer.invoke('shell:readText'),
  copyText: (t: string): Promise<boolean> => ipcRenderer.invoke('shell:copyText', t),
  htmlToPng: (p: string): Promise<{ out: string; w: number; h: number } | null> => ipcRenderer.invoke('html:toPng', p),
  onFsEvent: (cb: (m: { dirs: string[] }) => void) => ipcRenderer.on('shell:fsEvent', (_e, m) => cb(m)),
  onRootsChanged: (cb: (m: { framework: string; vault: string }) => void) => ipcRenderer.on('shell:rootsChanged', (_e, m) => cb(m)),
});
