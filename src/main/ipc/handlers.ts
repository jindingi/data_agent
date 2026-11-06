import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { commandSchema, type Result, type SystemInfo } from '../../shared/contracts/ipc';
import { IPC_COMMAND } from '../../shared/channels';
import { AppError } from '../../shared/errors';
import type { AgentProcess } from '../services/agent-process';
import type { SessionService } from '../services/sessions';
import type { FilePicker } from '../services/file-picker';
import type { HistoryItem } from '../../shared/models';
import type { CredentialService } from '../services/credentials';
import type { RuntimeService } from '../services/runtime';
import type { MessageView } from '../../shared/runtime';

export function registerHandlers(trusted: (event: IpcMainInvokeEvent) => boolean, info: () => SystemInfo, host: AgentProcess, sessions: SessionService, picker: FilePicker, changed: () => void, credentials: CredentialService, runtime: RuntimeService, catalogReady: Promise<void>) {
  ipcMain.handle(IPC_COMMAND, async (event, raw): Promise<Result> => {
    if (!trusted(event)) return { ok: false, error: { code: 'UNTRUSTED_SENDER', message: '请求来源不受信任' } };
    const parsed = commandSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: { code: 'INVALID_COMMAND', message: '请求格式不正确或操作不受支持' } };
    try {
      switch (parsed.data.type) {
        case 'system.info': return { ok: true, value: info() };
        case 'models.settings': await catalogReady; return { ok: true, value: credentials.settings() };
        case 'models.select': await catalogReady; return { ok: true, value: credentials.select(parsed.data.model) };
        case 'models.key': await catalogReady; return { ok: true, value: credentials.save(parsed.data.provider, parsed.data.key) };
        case 'runtime.submit': await catalogReady; return { ok: true, value: await runtime.submit(parsed.data.sessionId, parsed.data.input) };
        case 'runtime.snapshot': return { ok: true, value: runtime.snapshot(parsed.data.sessionId) };
        case 'runtime.cancel': await runtime.cancel(parsed.data.sessionId); return { ok: true, value: null };
        case 'system.ping': return { ok: true, value: await host.ping(parsed.data.text) };
        case 'sessions.list': return { ok: true, value: sessions.list(parsed.data.search, parsed.data.archived) };
        case 'sessions.create': {
          const directory = parsed.data.chooseWorkspace ? await picker.chooseDirectory() : undefined;
          if (parsed.data.chooseWorkspace && !directory) return { ok: true, value: null };
          const value = sessions.create(directory); changed(); return { ok: true, value };
        }
        case 'sessions.open': {
          if (!runtime.snapshot(parsed.data.sessionId)) sessions.reconcile(parsed.data.sessionId);
          const session = sessions.get(parsed.data.sessionId);
          const active = runtime.snapshot(session.id);
          // Active history comes from its sole writer's snapshot, not a second SessionManager.
          const transcript = !active && session.state === 'persisted' && session.piSessionId ? await host.readHistory(session.sessionFile, session.workspace, session.piSessionId) as { items: HistoryItem[]; messages: MessageView[] } : { items: [], messages: active?.messages ?? [] };
          return { ok: true, value: { session, files: sessions.files(session.id), history: transcript.items, messages: transcript.messages } };
        }
        case 'sessions.rename': { const value = sessions.rename(parsed.data.sessionId, parsed.data.title); changed(); return { ok: true, value }; }
        case 'sessions.archive': { const value = sessions.archive(parsed.data.sessionId, parsed.data.archived); changed(); return { ok: true, value }; }
        case 'files.pick': { const value = sessions.addFiles(parsed.data.sessionId, await picker.chooseFiles()); changed(); return { ok: true, value }; }
        case 'files.remove': { const value = sessions.removeFile(parsed.data.sessionId, parsed.data.fileId); changed(); return { ok: true, value }; }
      }
    } catch (error) {
      return { ok: false, error: { code: error instanceof AppError ? error.code : 'INTERNAL_ERROR', message: error instanceof AppError ? error.message : '操作失败，请重试' } };
    }
  });
}
