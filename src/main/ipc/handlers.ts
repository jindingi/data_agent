import { ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
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
import type { ArtifactService } from '../services/artifacts';
import type { DeletionService } from '../services/deletion';
import type { LogService } from '../services/logs';
import type { InteractionBroker } from '../services/interactions';

export function registerHandlers(trusted: (event: IpcMainInvokeEvent) => boolean, info: () => SystemInfo, host: AgentProcess, sessions: SessionService, picker: FilePicker, changed: () => void, credentials: CredentialService, runtime: RuntimeService, catalogReady: Promise<void>, interactions: InteractionBroker, automationControl?: (action: 'close_reopen' | 'quit' | 'host_pid', sessionId?: string) => unknown, artifacts?: ArtifactService, logs?: LogService, deletion?: DeletionService) {
  ipcMain.handle(IPC_COMMAND, async (event, raw): Promise<Result> => {
    if (!trusted(event)) return { ok: false, error: { code: 'UNTRUSTED_SENDER', message: '请求来源不受信任' } };
    const parsed = commandSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: { code: 'INVALID_COMMAND', message: '请求格式不正确或操作不受支持' } };
    try {
      switch (parsed.data.type) {
        case 'automation.control': {
          if (!automationControl) throw new AppError('UNSUPPORTED_COMMAND', '自动化入口未开启');
          return { ok: true, value: automationControl(parsed.data.action, parsed.data.sessionId) };
        }
        case 'artifacts.list': return { ok: true, value: artifacts!.list(parsed.data.sessionId) };
        case 'artifacts.preview': return { ok: true, value: await artifacts!.preview(parsed.data.sessionId, parsed.data.artifactId) };
        case 'artifacts.export': {
          const parent = await picker.chooseExportDirectory();
          return { ok: true, value: parent ? await artifacts!.exportVersion(parsed.data.sessionId, parsed.data.versionId, parent) : null };
        }
        case 'workspace.open': { const error = await shell.openPath(sessions.get(parsed.data.sessionId).workspace); if (error) throw new AppError('OPEN_FAILED', '无法打开工作区'); return { ok: true, value: null }; }
        case 'link.open': {
          const url = new URL(parsed.data.url); if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new AppError('INVALID_LINK', '只允许打开普通 HTTP/HTTPS 链接');
          await shell.openExternal(url.href); return { ok: true, value: null };
        }
        case 'system.info': return { ok: true, value: info() };
        case 'models.settings': await catalogReady; return { ok: true, value: credentials.settings() };
        case 'models.select': await catalogReady; return { ok: true, value: credentials.select(parsed.data.model) };
        case 'models.thinking': await catalogReady; return { ok: true, value: credentials.setThinking(parsed.data.level) };
        case 'models.key': await catalogReady; return { ok: true, value: credentials.save(parsed.data.provider, parsed.data.key) };
        case 'runtime.submit': await catalogReady; return { ok: true, value: await runtime.submit(parsed.data.sessionId, parsed.data.input) };
        case 'runtime.snapshot': return { ok: true, value: await runtime.restoreSnapshot(parsed.data.sessionId) };
        case 'runtime.discardDraft': runtime.discardDraft(parsed.data.sessionId, parsed.data.inputId); return { ok: true, value: null };
        case 'runtime.cancel': await runtime.cancel(parsed.data.sessionId); return { ok: true, value: null };
        case 'interaction.answer': {
          const input = parsed.data;
          interactions.answer({ id: input.interactionId, sessionId: input.sessionId, runId: input.runId, hostEpoch: input.hostEpoch, digest: input.digest }, input.answer);
          return { ok: true, value: null };
        }
        case 'system.ping': return { ok: true, value: await host.ping(parsed.data.text) };
        case 'sessions.deletePreview': return { ok: true, value: deletion!.preview(parsed.data.sessionId) };
        case 'sessions.delete': return { ok: true, value: await deletion!.remove(parsed.data.sessionId, parsed.data.deleteArtifacts) };
        case 'logs.list': return { ok: true, value: logs!.list(parsed.data.sessionId, parsed.data.toolCallId) };
        case 'logs.page': return { ok: true, value: await logs!.page(parsed.data.sessionId, parsed.data.logId, parsed.data.offset) };
        case 'sessions.list': return { ok: true, value: sessions.list(parsed.data.search, parsed.data.archived) };
        case 'sessions.create': {
          const directory = parsed.data.chooseWorkspace ? await picker.chooseDirectory() : undefined;
          if (parsed.data.chooseWorkspace && !directory) return { ok: true, value: null };
          const value = sessions.create(directory); changed(); return { ok: true, value };
        }
        case 'sessions.open': {
          if (!runtime.snapshot(parsed.data.sessionId)) sessions.reconcile(parsed.data.sessionId);
          const session = sessions.get(parsed.data.sessionId);
          const active = await runtime.restoreSnapshot(session.id);
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
