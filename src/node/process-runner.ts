import { toolLogPath } from './tool-log-path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RuntimePaths } from './runtime-paths';

export interface ProcessResult {
  output: string;
  exitCode: number | null;
  reason: string;
  peakRss: number;
  truncated: boolean;
  pid: number | null;
}
interface Options {
  sessionId: string;
  outputRoot?: string;
  argv: string[];
  cwd: string;
  runId: string;
  toolCallId: string;
  hostPid: number;
  signal?: AbortSignal;
  timeoutSeconds?: number;
  onOutput?: (text: string) => void;
}
export class ProcessRunner {
  private children = new Set<ChildProcessWithoutNullStreams>();
  private logBytes = new Map<string, number>();
  constructor(
    private paths: RuntimePaths,
    private logs: string,
  ) {}
  releaseRun(runId: string) {
    this.logBytes.delete(runId);
  }
  get runCount() {
    return this.logBytes.size;
  }
  environment(workspace: string) {
    const cache = join(workspace, '.cache');
    const home = join(workspace, '.home');
    const temp = join(workspace, '.tmp');
    for (const dir of [cache, home, temp]) mkdirSync(dir, { recursive: true });
    return {
      PATH: `${this.paths.bin}:${dirname(this.paths.python)}:/usr/bin:/bin`,
      HOME: home,
      TMPDIR: temp,
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      PYTHONNOUSERSITE: '1',
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONUNBUFFERED: '1',
      PYTHONPATH: this.paths.helpers,
      MPLBACKEND: 'Agg',
      MPLCONFIGDIR: join(cache, 'matplotlib'),
      DATA_AGENT_FONT: this.paths.font,
      PIP_NO_INDEX: '1',
    };
  }
  async run(options: Options): Promise<ProcessResult> {
    options.signal?.throwIfAborted();
    const env = this.environment(options.cwd);
    const logFile = toolLogPath(this.logs, options.sessionId, options.runId, options.toolCallId);
    mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 });
    return new Promise((resolve, reject) => {
      const child = spawn(
        this.paths.python,
        ['-I', '-B', join(this.paths.helpers, 'supervisor.py')],
        { env, cwd: options.cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      this.children.add(child);
      let protocol = '',
        bytes = 0,
        chunks: Buffer[] = [],
        settled = false;
      let result: ProcessResult = {
        output: '',
        exitCode: null,
        reason: 'supervisor_error',
        peakRss: 0,
        truncated: false,
        pid: null,
      };
      const cancel = () => {
        child.stdin.end();
      };
      options.signal?.addEventListener('abort', cancel, { once: true });
      child.stdin.on('error', () => {});
      child.stderr.resume();
      child.stdout.on('data', (chunk: Buffer) => {
        protocol += chunk.toString('utf8');
        if (protocol.length > 512 * 1024) {
          child.stdin.end();
          protocol = '';
          return;
        }
        let end: number;
        while ((end = protocol.indexOf('\n')) !== -1) {
          const line = protocol.slice(0, end);
          protocol = protocol.slice(end + 1);
          try {
            const message = JSON.parse(line);
            if (message.type === 'started') result.pid = message.pid;
            if (message.type === 'finished')
              result = {
                ...result,
                exitCode: message.exitCode,
                reason: message.reason,
                peakRss: message.peakRss,
              };
            if (message.type === 'output') {
              const output = Buffer.from(message.data, 'base64');
              const available = Math.max(0, 60 * 1024 - bytes);
              if (available) {
                const part = output.subarray(0, available);
                chunks.push(part);
                bytes += part.length;
                options.onOutput?.(Buffer.concat(chunks).toString('utf8'));
              }
              if (output.length > available) result.truncated = true;
              const logged = this.logBytes.get(options.runId) ?? 0;
              const logPart = output.subarray(0, Math.max(0, 10 * 1024 * 1024 - logged));
              if (logPart.length) {
                appendFileSync(logFile, logPart, { mode: 0o600 });
                this.logBytes.set(options.runId, logged + logPart.length);
              }
            }
          } catch {
            result.reason = 'supervisor_protocol_error';
            cancel();
          }
        }
      });
      const finish = () => {
        this.children.delete(child);
        options.signal?.removeEventListener('abort', cancel);
        if (settled) return;
        settled = true;
        result.output =
          Buffer.concat(chunks).toString('utf8') +
          (result.truncated ? '\n[输出已截断；完整日志受每次任务 10 MiB 上限约束。]' : '');
        chunks = [];
        resolve(result);
      };
      child.once('error', () => {
        if (!settled) {
          settled = true;
          this.children.delete(child);
          options.signal?.removeEventListener('abort', cancel);
          reject(new Error('内置工具进程无法启动'));
        }
      });
      child.once('close', finish);
      child.stdin.write(
        JSON.stringify({
          argv: options.argv,
          cwd: options.cwd,
          env,
          outputRoot: options.outputRoot,
          mainPid: process.pid,
          hostPid: options.hostPid,
          timeoutSeconds: Math.min(options.timeoutSeconds ?? 180, 180),
        }) + '\n',
      );
      if (options.signal?.aborted) cancel();
    });
  }
  stop() {
    for (const child of this.children) child.stdin.end();
  }
}
