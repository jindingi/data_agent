import { hostRequestSchema } from '../shared/contracts/host';
import { readHistory } from './history';
import { AppError } from '../shared/errors';
import { SessionRuntime } from './session-runtime';
import { createModelRuntime, modelCatalog } from './models';
import { ToolClient } from './tool-client';

// This entry is deliberately independent from Main and Renderer implementations.
const parent = (
  process as NodeJS.Process & {
    parentPort?: {
      on: (
        event: string,
        listener: (event: { data: unknown; ports: Electron.MessagePortMain[] }) => void,
      ) => void;
    };
  }
).parentPort;
if (!parent) throw new Error('Agent Host must run in an Electron utilityProcess');
parent.on('message', ({ ports }) => {
  const port = ports[0];
  if (!port) return;
  let runtime: SessionRuntime | undefined;
  const tools = new ToolClient((message) => port.postMessage(message));
  let initializing = false;
  port.on('message', async ({ data }) => {
    const parsed = hostRequestSchema.safeParse(data);
    if (!parsed.success) return;
    const request = parsed.data;
    if (tools.receive(request)) return;
    try {
      switch (request.type) {
        case 'ping':
          port.postMessage({ type: 'pong', id: request.id, text: request.text, pid: process.pid });
          break;
        case 'history.read':
          port.postMessage({
            type: 'history',
            id: request.id,
            ...readHistory(request.file, request.workspace, request.piSessionId),
          });
          break;
        case 'models.list':
          port.postMessage({
            type: 'models',
            id: request.id,
            models: modelCatalog(await createModelRuntime()),
          });
          break;
        case 'runtime.start': {
          if (runtime || initializing) throw new AppError('HOST_BUSY', '该 Agent 进程已有任务');
          initializing = true;
          try {
            runtime = await SessionRuntime.create(
              request.config,
              (snapshot) => port.postMessage({ type: 'runtime.event', snapshot }),
              { tools },
            );
            await runtime.submit(request.input);
            port.postMessage({ type: 'accepted', id: request.id });
          } finally {
            initializing = false;
          }
          break;
        }
        case 'runtime.input':
          if (!runtime) throw new AppError('NOT_RUNNING', '任务尚未启动');
          await runtime.submit(request.input);
          port.postMessage({ type: 'accepted', id: request.id });
          break;
        case 'runtime.cancel':
          if (runtime) await runtime.cancel();
          port.postMessage({ type: 'accepted', id: request.id });
          break;
        case 'runtime.snapshot':
          if (!runtime) throw new AppError('NOT_RUNNING', '任务尚未启动');
          port.postMessage({ type: 'snapshot', id: request.id, snapshot: runtime.snapshot() });
          break;
      }
    } catch (error) {
      port.postMessage({
        type: 'error',
        id: request.id,
        code: error instanceof AppError ? error.code : 'HOST_ERROR',
        message: error instanceof AppError ? error.message : 'Agent 操作失败',
      });
    }
  });
  port.start();
  port.postMessage({ type: 'ready', pid: process.pid });
});
