import { hostRequestSchema } from '../shared/contracts/host';

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
    if (parsed.success) port.postMessage({ type: 'pong', id: parsed.data.id, text: parsed.data.text, pid: process.pid });
  });
  port.start(); port.postMessage({ type: 'ready', pid: process.pid });
});
