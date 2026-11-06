import { app, BrowserWindow, Menu, safeStorage } from 'electron';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
import { ensureAppPaths, getAppPaths } from '../node/app-paths';
import { openDatabase } from './storage/database';
import { SessionService } from './services/sessions';
import { FilePicker } from './services/file-picker';
import { AgentProcess } from './services/agent-process';
import { CredentialService } from './services/credentials';
import { RuntimeService } from './services/runtime';
import type { ModelOption } from '../shared/runtime';
import { registerHandlers } from './ipc/handlers';
import { IPC_EVENT } from '../shared/channels';
import type { SystemInfo } from '../shared/contracts/ipc';

app.setName('Data Agent');
const automation = process.argv.includes('--data-agent-automation');
if (!automation) {
  app.commandLine.removeSwitch('remote-debugging-port');
  app.commandLine.removeSwitch('remote-debugging-pipe');
} else {
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
}
const paths = getAppPaths(process.env, automation);
ensureAppPaths(paths);
if (process.env.DATA_AGENT_USER_DATA) app.setPath('userData', process.env.DATA_AGENT_USER_DATA);
const here = fileURLToPath(new URL('.', import.meta.url));
const rendererFile = join(here, '../renderer/index.html');
const rendererURL = !app.isPackaged && process.env.ELECTRON_RENDERER_URL ? process.env.ELECTRON_RENDERER_URL : pathToFileURL(rendererFile).href;
let window: BrowserWindow | null = null;
let host: AgentProcess | undefined;
let db: ReturnType<typeof openDatabase> | undefined;
let runtime: RuntimeService | undefined;

function createWindow() {
  window = new BrowserWindow({
    width: 1360, height: 900, minWidth: 940, minHeight: 650, title: 'Data Agent', backgroundColor: '#141518',
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 20 },
    webPreferences: { preload: join(here, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== rendererURL) event.preventDefault(); });
  window.on('closed', () => { window = null; });
  void window.loadURL(rendererURL);
}
app.whenReady().then(() => {
  db = openDatabase(paths.database);
  const sessions = new SessionService(db, paths);
  sessions.reconcile();
  host = new AgentProcess(join(here, 'agent.js'), (status) => {
    if (window && !window.isDestroyed()) window.webContents.send(IPC_EVENT, { type: 'host.status', status });
  });
  const credentials = new CredentialService(db, safeStorage);
  const catalogReady = host.request({ type: 'models.list' }).then(value => { credentials.setCatalog((value as { models: ModelOption[] }).models); });
  void catalogReady.catch(() => {});
  const changed = () => { if (window && !window.isDestroyed()) window.webContents.send(IPC_EVENT, { type: 'sessions.changed' }); };
  runtime = new RuntimeService(db, sessions, credentials, paths, (status, snapshot) => new AgentProcess(join(here, 'agent.js'), status, snapshot), host, snapshot => {
    if (window && !window.isDestroyed()) window.webContents.send(IPC_EVENT, { type: 'runtime.event', snapshot });
  }, changed);
  const info = (): SystemInfo => ({
    version: app.getVersion(), platform: process.platform, architecture: process.arch,
    electron: process.versions.electron, node: process.versions.node, abi: process.versions.modules,
    packaged: app.isPackaged, dataHome: paths.home, workspaceRoot: paths.workspace,
    hostStatus: host!.status, hostPid: host!.pid,
    sqliteVersion: (db!.prepare('SELECT sqlite_version() AS version').get() as { version: string }).version,
  });
  registerHandlers((event) => Boolean(window && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame && event.senderFrame.url === rendererURL), info, host, sessions, new FilePicker(() => window, automation), changed, credentials, runtime, catalogReady);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Data Agent', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { type: 'separator' }, { role: 'quit' }] },
    { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' },
  ]));
  createWindow();
  console.log('Data Agent ready');
  if (automation) writeFileSync(join(paths.home, 'automation.json'), JSON.stringify({ pid: process.pid, userData: app.getPath('userData'), paths, debugPort: app.commandLine.getSwitchValue('remote-debugging-port'), packaged: app.isPackaged }));
}).catch((error) => { console.error('Startup failed:', error.message); app.exit(1); });
app.on('activate', () => { if (!window && db) createWindow(); });
app.on('window-all-closed', () => { /* macOS background tasks remain active. */ });
app.on('before-quit', () => { runtime?.stop(); host?.stop(); db?.close(); db = undefined; });
process.on('SIGTERM', () => app.quit());
