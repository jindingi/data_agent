import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { commandSchema, type Result, type SystemInfo } from '../../shared/contracts/ipc';
import { IPC_COMMAND } from '../../shared/channels';
import { AppError } from '../../shared/errors';
import type { AgentProcess } from '../services/agent-process';

export function registerHandlers(trusted: (event: IpcMainInvokeEvent) => boolean, info: () => SystemInfo, host: AgentProcess) {
  ipcMain.handle(IPC_COMMAND, async (event, raw): Promise<Result> => {
    if (!trusted(event)) return { ok: false, error: { code: 'UNTRUSTED_SENDER', message: '请求来源不受信任' } };
    const parsed = commandSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: { code: 'INVALID_COMMAND', message: '请求格式不正确或操作不受支持' } };
    try {
      switch (parsed.data.type) {
        case 'system.info': return { ok: true, value: info() };
        case 'system.ping': return { ok: true, value: await host.ping(parsed.data.text) };
      }
    } catch (error) {
      return { ok: false, error: { code: error instanceof AppError ? error.code : 'INTERNAL_ERROR', message: error instanceof AppError ? error.message : '操作失败，请重试' } };
    }
  });
}
