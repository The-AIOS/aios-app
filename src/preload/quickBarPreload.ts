/**
 * The quick bar's preload — deliberately narrow (docs/rfcs/menu-bar.md § 3.3). The bar can list where a
 * message may go, suggest a name, submit and close. It cannot reach a terminal, a file or a setting.
 */
import { contextBridge, ipcRenderer } from 'electron';

type Dest = { kind: 'new' | 'agent' | 'session'; name: string };

contextBridge.exposeInMainWorld('quickBar', {
  destinations: (): Promise<unknown> => ipcRenderer.invoke('quickBar:destinations'),
  suggestName: (text: string): Promise<string> => ipcRenderer.invoke('quickBar:suggestName', text),
  submit: (dest: Dest, text: string, reveal: boolean): Promise<{ ok: boolean; reason?: string }> =>
    ipcRenderer.invoke('quickBar:submit', dest, text, reveal),
  close: (): void => ipcRenderer.send('quickBar:close'),
  onOpen: (cb: (msg: { theme: 'dark' | 'light' }) => void): void => { ipcRenderer.on('quickBar:open', (_e, msg) => cb(msg)); },
});
