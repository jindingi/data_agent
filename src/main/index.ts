import { app, BrowserWindow, Menu, safeStorage, nativeImage } from 'electron';
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
import { ToolService } from './services/tools';
import { DeletionService } from './services/deletion';
import { LogService } from './services/logs';
import { ArtifactService } from './services/artifacts';
import { InteractionBroker } from './services/interactions';
import { getRuntimePaths } from '../node/runtime-paths';
import type { ModelOption } from '../shared/runtime';
import { registerHandlers } from './ipc/handlers';
import { IPC_EVENT } from '../shared/channels';
import type { SystemInfo } from '../shared/contracts/ipc';

app.setName('Data Agent');
const automation = process.argv.includes('--data-agent-automation');
// Presentation only: this flag never enables automation IPC or test credentials.
const background = process.argv.includes('--data-agent-background');
if (background && process.platform === 'darwin') app.setActivationPolicy('accessory');
if (!automation) {
  app.commandLine.removeSwitch('remote-debugging-port');
  app.commandLine.removeSwitch('remote-debugging-pipe');
} else {
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
}
const paths = getAppPaths(process.env, automation);
ensureAppPaths(paths);
if (process.env.DATA_AGENT_USER_DATA) app.setPath('userData', process.env.DATA_AGENT_USER_DATA);
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) {
  console.log('Data Agent already running');
  app.exit(0);
}
const here = fileURLToPath(new URL('.', import.meta.url));
const rendererFile = join(here, '../renderer/index.html');
// Chromium canonicalizes loaded URLs (notably adding '/' to a bare HTTP origin).
// Compare against that same representation, while retaining exact-document trust.
const rendererURL = new URL(
  !app.isPackaged && process.env.ELECTRON_RENDERER_URL
    ? process.env.ELECTRON_RENDERER_URL
    : pathToFileURL(rendererFile).href,
).href;
let window: BrowserWindow | null = null;
let host: AgentProcess | undefined;
let db: ReturnType<typeof openDatabase> | undefined;
let runtime: RuntimeService | undefined;
let artifacts: ArtifactService | undefined;
let deletion: DeletionService | undefined;
let quitting = false;

function createWindow() {
  window = new BrowserWindow({
    show: !background,
    width: 1360,
    height: 900,
    minWidth: 940,
    minHeight: 650,
    title: 'Data Agent',
    backgroundColor: '#141518',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 20 },
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: !background,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== rendererURL) event.preventDefault();
  });
  window.on('closed', () => {
    window = null;
  });
  void window.loadURL(rendererURL);
}
if (primaryInstance)
  void app
    .whenReady()
    .then(() => {
      db = openDatabase(paths.database);
      const sessions = new SessionService(db, paths);
      sessions.recoverIntents();
      sessions.reconcile();
      host = new AgentProcess(join(here, 'agent.js'), (status) => {
        if (window && !window.isDestroyed())
          window.webContents.send(IPC_EVENT, { type: 'host.status', status });
      });
      const credentials = new CredentialService(db, safeStorage);
      artifacts = new ArtifactService(
        db,
        sessions,
        (bytes) => !nativeImage.createFromBuffer(bytes).isEmpty(),
        (sessionId) => {
          if (window && !window.isDestroyed())
            window.webContents.send(IPC_EVENT, { type: 'artifacts.changed', sessionId });
        },
      );
      for (const session of [...sessions.list(), ...sessions.list('', true)])
        if (session.state !== 'deleting')
          for (const version of artifacts.list(session.id).versions)
            if (version.state === 'open') void artifacts.publish(version.id);
      const interactions = new InteractionBroker(db);
      const logs = new LogService(db, paths.logs);
      const tools = new ToolService(
        getRuntimePaths(app.getAppPath(), process.resourcesPath, app.isPackaged),
        paths.logs,
        interactions,
        logs.register,
      );
      const catalogReady = host.request({ type: 'models.list' }).then((value) => {
        credentials.setCatalog((value as { models: ModelOption[] }).models);
      });
      void catalogReady.catch(() => {});
      const changed = () => {
        if (window && !window.isDestroyed())
          window.webContents.send(IPC_EVENT, { type: 'sessions.changed' });
      };
      runtime = new RuntimeService({
        db: db,
        sessions: sessions,
        credentials: credentials,
        paths: paths,
        createHost: (status, snapshot, tool, cancelTool) =>
          new AgentProcess(join(here, 'agent.js'), status, snapshot, tool, cancelTool),
        reader: host,
        publish: (snapshot) => {
          if (window && !window.isDestroyed())
            window.webContents.send(IPC_EVENT, { type: 'runtime.event', snapshot });
        },
        changed: changed,
        tools: tools,
        testBaseUrl: automation ? process.env.DATA_AGENT_TEST_MODEL_BASE_URL : undefined,
        artifacts: artifacts,
        skillsDirectory: app.isPackaged
          ? join(process.resourcesPath, 'skills')
          : join(app.getAppPath(), 'resources/skills'),
      });
      deletion = new DeletionService(db, sessions, runtime, artifacts, paths, changed);
      const info = (): SystemInfo => ({
        version: app.getVersion(),
        platform: process.platform,
        architecture: process.arch,
        electron: process.versions.electron,
        node: process.versions.node,
        abi: process.versions.modules,
        packaged: app.isPackaged,
        dataHome: paths.home,
        workspaceRoot: paths.workspace,
        hostStatus: host!.status,
        hostPid: host!.pid,
        sqliteVersion: (
          db!.prepare('SELECT sqlite_version() AS version').get() as { version: string }
        ).version,
      });
      registerHandlers({
        trusted: (event) =>
          Boolean(
            window &&
            event.sender === window.webContents &&
            event.senderFrame === window.webContents.mainFrame &&
            event.senderFrame.url === rendererURL,
          ),
        info: info,
        host: host,
        sessions: sessions,
        picker: new FilePicker(() => window, automation),
        changed: changed,
        credentials: credentials,
        runtime: runtime,
        catalogReady: catalogReady,
        testBaseUrl: automation ? process.env.DATA_AGENT_TEST_MODEL_BASE_URL : undefined,
        interactions: interactions,
        automationControl: automation
          ? (action, sessionId) => {
              if (action === 'host_pid') return sessionId ? runtime!.hostPid(sessionId) : null;
              if (action === 'quit') setTimeout(() => app.quit(), 100);
              if (action === 'close_reopen')
                setTimeout(() => {
                  window?.close();
                  setTimeout(() => {
                    if (!window) app.emit('activate');
                  }, 500);
                }, 100);
              return null;
            }
          : undefined,
        artifacts: artifacts,
        logs: logs,
        deletion: deletion,
      });
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: 'Data Agent',
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
          { role: 'editMenu' },
          { role: 'viewMenu' },
          { role: 'windowMenu' },
        ]),
      );
      createWindow();
      console.log('Data Agent ready');
      if (automation)
        writeFileSync(
          join(paths.home, 'automation.json'),
          JSON.stringify({
            pid: process.pid,
            userData: app.getPath('userData'),
            paths,
            debugPort: app.commandLine.getSwitchValue('remote-debugging-port'),
            packaged: app.isPackaged,
            background,
            windowVisible: window?.isVisible(),
            windowFocused: window?.isFocused(),
          }),
        );
    })
    .catch((error) => {
      console.error('Startup failed:', error.message);
      app.exit(1);
    });
app.on('second-instance', () => {
  if (background) return;
  if (!window && db) createWindow();
  if (window) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }
});
app.on('activate', () => {
  if (!window && db) createWindow();
});
app.on('window-all-closed', () => {
  /* macOS background tasks remain active. */
});
app.on('before-quit', (event) => {
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  const stopped = runtime?.stop();
  host?.stop();
  void Promise.resolve(stopped)
    .then(() => deletion?.settled())
    .then(() => artifacts?.settled())
    .finally(() => {
      db?.close();
      db = undefined;
      app.exit(0);
    });
});
process.on('SIGTERM', () => app.quit());
