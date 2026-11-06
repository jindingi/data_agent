import { contextBridge, ipcRenderer } from 'electron';
import { IPC_COMMAND, IPC_EVENT } from '../shared/channels';
import type { AppEvent, DesktopAPI } from '../shared/contracts/ipc';

const api: DesktopAPI = {
  request: (command) => ipcRenderer.invoke(IPC_COMMAND, { ...command, requestId: crypto.randomUUID() }),
  subscribe: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, payload: AppEvent) => listener(payload);
    ipcRenderer.on(IPC_EVENT, callback);
    return () => { ipcRenderer.removeListener(IPC_EVENT, callback); };
  },
};
contextBridge.exposeInMainWorld('dataAgent', api);
