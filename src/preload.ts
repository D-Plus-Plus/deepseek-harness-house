import { contextBridge, ipcRenderer } from 'electron';
import type { ShellState } from './types.js';

const api = {
  getState: (): Promise<ShellState> => ipcRenderer.invoke('shell:get-state') as Promise<ShellState>,
  retry: (): Promise<void> => ipcRenderer.invoke('shell:retry') as Promise<void>,
  onStateChanged: (listener: (state: ShellState) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: ShellState): void => listener(state);
    ipcRenderer.on('shell:state-changed', handler);
    return () => ipcRenderer.removeListener('shell:state-changed', handler);
  },
};

contextBridge.exposeInMainWorld('shellApi', api);
