import { ipcMain } from 'electron';
import { commandSchema, type Result } from '../../shared/contracts/ipc';
import { IPC_COMMAND } from '../../shared/channels';
import { AppError } from '../../shared/errors';
import { dispatchCommand } from './commands';
import type { HandlerDependencies } from './dependencies';
export function registerHandlers(dependencies: HandlerDependencies) {
  ipcMain.handle(IPC_COMMAND, async (event, raw): Promise<Result> => {
    if (!dependencies.trusted(event))
      return { ok: false, error: { code: 'UNTRUSTED_SENDER', message: '请求来源不受信任' } };
    const parsed = commandSchema.safeParse(raw);
    if (!parsed.success)
      return {
        ok: false,
        error: { code: 'INVALID_COMMAND', message: '请求格式不正确或操作不受支持' },
      };
    try {
      return await dispatchCommand(parsed.data, dependencies);
    } catch (error) {
      return {
        ok: false,
        error: {
          code: error instanceof AppError ? error.code : 'INTERNAL_ERROR',
          message: error instanceof AppError ? error.message : '操作失败，请重试',
        },
      };
    }
  });
}
