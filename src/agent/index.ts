import { hostRequestSchema } from '../shared/contracts/host';
import { readHistory } from './history';
import { AppError } from '../shared/errors';

// This entry is deliberately independent from Main and Renderer implementations.
const parent = (process as NodeJS.Process & {
  parentPort?: { on: (event: string, listener: (event: { data: unknown; ports: Electron.MessagePortMain[] }) => void) => void };
}).parentPort;
if (!parent) throw new Error('Agent Host must run in an Electron utilityProcess');
parent.on('message', ({ ports }) => {
  const port = ports[0];
  if (!port) return;
  port.on('message', ({ data }) => {
    const parsed = hostRequestSchema.safeParse(data);
    if (!parsed.success) return;
    const request = parsed.data;
    try {
      if (request.type === 'ping') port.postMessage({ type: 'pong', id: request.id, text: request.text, pid: process.pid });
      else port.postMessage({ type: 'history', id: request.id, ...readHistory(request.file, request.workspace, request.piSessionId) });
    } catch (error) {
      port.postMessage({ type: 'error', id: request.id, code: error instanceof AppError ? error.code : 'HISTORY_ERROR', message: error instanceof AppError ? error.message : '无法读取会话历史' });
    }
  });
  port.start(); port.postMessage({ type: 'ready', pid: process.pid });
});
