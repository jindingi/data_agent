import { toolLogPath } from './tool-log-path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RuntimePaths } from './runtime-paths';
import { ProcessOutput, type ProcessLogBudget } from './process-output';
import { executionLimits, toolLimits } from '../shared/tool-limits';

export interface ProcessResult {
  output: string;
  exitCode: number | null;
  reason: string;
  peakRss: number;
  truncated: boolean;
  pid: number | null;
  logPath?: string;
  logBytes?: number;
  logComplete?: boolean;
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
  saveOverflowLog?: boolean;
  captureOutputBytes?: number;
}
export class ProcessRunner {
  private children = new Set<ChildProcessWithoutNullStreams>();
  private logBudgets = new Map<string, ProcessLogBudget>();
  constructor(
    private paths: RuntimePaths,
    private logs: string,
  ) {}
  releaseRun(runId: string) {
    this.logBudgets.delete(runId);
  }
  get runCount() {
    return this.logBudgets.size;
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
    let log: { path: string; budget: ProcessLogBudget } | undefined;
    if (options.saveOverflowLog) {
      const budget = this.logBudgets.get(options.runId) ?? { remaining: toolLimits.runLogBytes };
      this.logBudgets.set(options.runId, budget);
      log = {
        path: toolLogPath(this.logs, options.sessionId, options.runId, options.toolCallId),
        budget,
      };
    }
    const output = new ProcessOutput({
      maxBytes: options.captureOutputBytes ?? toolLimits.bashPreviewBytes,
      mode: options.captureOutputBytes ? 'raw' : 'head-tail',
      log,
    });
    return new Promise((resolve, reject) => {
      const child = spawn(
        this.paths.python,
        ['-I', '-B', join(this.paths.helpers, 'supervisor.py')],
        { env, cwd: options.cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      this.children.add(child);
      let captureLimited = false;
      let protocol = '',
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
        if (protocol.length > toolLimits.processProtocolBytes) {
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
              const wasTruncated = output.truncated;
              const text = output.append(Buffer.from(message.data, 'base64'));
              if (!wasTruncated) options.onOutput?.(text);
              if (options.captureOutputBytes && output.truncated && !captureLimited) {
                captureLimited = true;
                cancel();
              }
            }
          } catch {
            result.reason = 'supervisor_protocol_error';
            cancel();
          }
        }
      });
      const finish = async () => {
        this.children.delete(child);
        options.signal?.removeEventListener('abort', cancel);
        if (settled) return;
        settled = true;
        Object.assign(result, await output.finish());
        if (captureLimited) result.reason = 'capture_limit';
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
          timeoutSeconds: Math.min(
            options.timeoutSeconds ?? toolLimits.timeoutSeconds,
            toolLimits.timeoutSeconds,
          ),
          limits: executionLimits,
        }) + '\n',
      );
      if (options.signal?.aborted) cancel();
    });
  }
  stop() {
    for (const child of this.children) child.stdin.end();
  }
}
