import { utilityProcess, MessageChannelMain, type UtilityProcess, type MessagePortMain } from 'electron';
import { randomUUID } from 'node:crypto';
import { hostResponseSchema, type HostInput } from '../../shared/contracts/host';
import { AppError } from '../../shared/errors';
import type { HostStatus } from '../../shared/contracts/ipc';
import type { RuntimeSnapshot } from '../../shared/runtime';

/** Owns one Host transport. Session admission will own separate instances per active session. */
export class AgentProcess {
  status: HostStatus = 'starting';
  pid: number | null = null;
  private child: UtilityProcess | undefined;
  private port: MessagePortMain | undefined;
  private pending = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private ready: Promise<void>;
  constructor(entry: string, onStatus: (status: HostStatus) => void, onSnapshot: (snapshot: RuntimeSnapshot) => void = () => {}) {
    this.ready = new Promise((resolve, reject) => {
      const readyTimer = setTimeout(() => { reject(new AppError('HOST_TIMEOUT', 'Agent 进程启动超时')); this.stop(); }, 15_000);
      this.child = utilityProcess.fork(entry, [], {
        serviceName: 'Data Agent Host', stdio: 'pipe',
        // Credentials are intentionally not inherited; later runs receive only their selected key.
        env: { PATH: '/usr/bin:/bin', LANG: process.env.LANG || 'en_US.UTF-8', TMPDIR: process.env.TMPDIR || '/tmp' },
      });
      // Drain SDK diagnostics without logging raw provider responses or credentials.
      this.child.stdout?.resume(); this.child.stderr?.resume();
      this.child.on('spawn', () => {
        this.pid = this.child!.pid ?? null;
        const { port1, port2 } = new MessageChannelMain();
        this.port = port1;
        port1.on('message', ({ data }) => {
          const parsed = hostResponseSchema.safeParse(data);
          if (!parsed.success) return;
          if (parsed.data.type === 'ready') {
            clearTimeout(readyTimer); this.status = 'ready'; onStatus('ready'); resolve();
          } else if (parsed.data.type === 'runtime.event') onSnapshot(parsed.data.snapshot);
          else {
            const request = this.pending.get(parsed.data.id);
            if (request) { clearTimeout(request.timer); this.pending.delete(parsed.data.id); if (parsed.data.type === 'error') request.reject(new AppError(parsed.data.code, parsed.data.message)); else request.resolve(parsed.data); }
          }
        });
        port1.start(); this.child!.postMessage({ type: 'connect' }, [port2]);
      });
      this.child.on('exit', () => {
        clearTimeout(readyTimer); this.status = 'exited'; this.pid = null;
        const error = new AppError('HOST_EXITED', 'Agent 进程已退出');
        reject(error);
        for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
        this.pending.clear(); this.port?.close(); onStatus('exited');
      });
    });
    // Constructor startup can fail before the first caller awaits it.
    void this.ready.catch(() => {});
  }
  ping(text: string) { return this.request({ type: 'ping', text }); }
  readHistory(file: string, workspace: string, piSessionId: string) { return this.request({ type: 'history.read', file, workspace, piSessionId }); }
  async request(input: HostInput) {
    await this.ready;
    if (this.status !== 'ready') throw new AppError('HOST_EXITED', 'Agent 进程已退出');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new AppError('HOST_TIMEOUT', 'Agent 未响应')); }, input.type === 'runtime.start' ? 30_000 : 5_000);
      this.pending.set(id, { resolve, reject, timer });
      this.port!.postMessage({ ...input, id });
    });
  }
  stop() { this.child?.kill(); }
}
