import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { IPC_COMMAND, IPC_EVENT } from '../shared/channels';
import type { AppEvent, DesktopAPI } from '../shared/contracts/ipc';

const api: DesktopAPI = {
  addFiles: (sessionId, files) => {
    const paths = files.map(file => webUtils.getPathForFile(file));
    if (!paths.length || paths.some(path => !path)) return Promise.resolve({ ok: false, error: { code: 'INVALID_FILE', message: '请拖入本机上的 CSV 文件' } });
    return ipcRenderer.invoke(IPC_COMMAND, { type: 'files.add', sessionId, paths, requestId: crypto.randomUUID() });
  },
  request: (command) => ipcRenderer.invoke(IPC_COMMAND, { ...command, requestId: crypto.randomUUID() }),
  subscribe: (listener) => {
    const callback = (_event: Electron.IpcRendererEvent, payload: AppEvent) => listener(payload);
    ipcRenderer.on(IPC_EVENT, callback);
    return () => { ipcRenderer.removeListener(IPC_EVENT, callback); };
  },
};
contextBridge.exposeInMainWorld('dataAgent', api);
