import { open, mkdir, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { PolicyService, digest, type PolicyContext } from './policy';
import { InteractionBroker } from './interactions';
import { ProcessRunner } from '../../node/process-runner';
import { readText } from '../../node/read-text';
import { canonicalPath, sensitivePath } from '../../node/path-policy';
import { requireRuntime, type RuntimePaths } from '../../node/runtime-paths';
import type { ToolOperation, ToolResult, Interaction } from '../../shared/tools';

export interface ToolContext extends PolicyContext { sessionId: string; runId: string; hostEpoch: string; hostPid: number }
export interface ToolObservers { output(text: string): void; interaction(value: Interaction | null): void }
interface Active { runId: string; toolCallId: string; abort: AbortController }
export class ToolService {
  private active = new Set<Active>();
  private tails = new Map<string, Promise<unknown>>();
  private closed = new Set<string>();
  readonly policy: PolicyService;
  readonly processes: ProcessRunner;
  constructor(private resources: RuntimePaths, logs: string, readonly broker: InteractionBroker) {
    this.policy = new PolicyService(resources); this.processes = new ProcessRunner(resources, logs);
  }
  execute(context: ToolContext, toolCallId: string, operation: ToolOperation, observers: ToolObservers): Promise<ToolResult> {
    const previous = this.tails.get(context.runId) ?? Promise.resolve();
    const item: Active = { runId: context.runId, toolCallId, abort: new AbortController() }; this.active.add(item);
    const task = previous.catch(() => {}).then(async () => {
      try {
        if (this.closed.has(context.runId)) throw new Error('任务已结束');
        item.abort.signal.throwIfAborted(); requireRuntime(this.resources);
        if (operation.name === 'ask_clarification') {
          const answer = await this.broker.request({ sessionId: context.sessionId, runId: context.runId, hostEpoch: context.hostEpoch, toolCallId, kind: 'clarification', digest: digest(operation), title: '需要补充信息', description: operation.question, options: operation.options ?? [] }, item.abort.signal, observers.interaction);
          return { output: JSON.stringify(answer), isError: answer.kind !== 'clarification' || answer.answer === null };
        }
        const decision = await this.policy.inspect(context, operation);
        if (decision.decision === 'deny') throw new Error(decision.reasons.join('；'));
        const binding = digest({ sessionId: context.sessionId, runId: context.runId, hostEpoch: context.hostEpoch, toolCallId, fingerprint: decision.fingerprint });
        if (decision.decision === 'ask') {
          const description = [decision.reasons.join('；'), operation.name === 'bash' ? operation.command : `${operation.name}: ${operation.path}`, ...decision.paths.map(item => `${item.action}: ${item.path}`), ...decision.scripts.map(item => `SHA256 ${item.hash}: ${item.path}`), ...decision.network].join('\n').slice(0, 20_000);
          const answer = await this.broker.request({ sessionId: context.sessionId, runId: context.runId, hostEpoch: context.hostEpoch, toolCallId, kind: 'approval', digest: binding, title: '批准这一次操作？', description, options: [] }, item.abort.signal, observers.interaction);
          if (answer.kind !== 'approval' || answer.decision !== 'allow_once') throw new Error('用户拒绝了这一次操作，未执行');
        }
        item.abort.signal.throwIfAborted();
        const checked = await this.policy.inspect(context, operation);
        if (checked.fingerprint !== decision.fingerprint || checked.decision === 'deny') throw new Error('操作路径、脚本或规则结果已变化，原批准已失效，请重新调用工具');
        return await this.perform(context, toolCallId, operation, item.abort.signal, observers, checked.paths[0]?.path);
      } catch (error) { return { output: item.abort.signal.aborted ? '操作已取消' : error instanceof Error ? error.message : '工具执行失败', isError: true }; }
      finally { this.active.delete(item); }
    });
    this.tails.set(context.runId, task);
    void task.finally(() => { if (this.tails.get(context.runId) === task) this.tails.delete(context.runId); });
    return task;
  }
  private async perform(context: ToolContext, toolCallId: string, operation: Exclude<ToolOperation, { name: 'ask_clarification' }>, signal: AbortSignal, observers: ToolObservers, checkedPath?: string): Promise<ToolResult> {
    signal.throwIfAborted();
    if (operation.name === 'read') { const result = await readText(context.workspace, context.protectedRoots, { ...operation, path: checkedPath! }, signal); return { ...result, isError: false }; }
    if (operation.name === 'bash') {
      const result = await this.processes.run({ argv: ['/bin/bash', '--noprofile', '--norc', '-c', operation.command], cwd: context.workspace, runId: context.runId, toolCallId, hostPid: context.hostPid, timeoutSeconds: operation.timeout, signal, onOutput: observers.output });
      return { output: result.output + (result.reason !== 'exit' ? `\n[执行结束：${result.reason}]` : result.exitCode ? `\n[退出码：${result.exitCode}]` : ''), isError: result.reason !== 'exit' || result.exitCode !== 0, details: { ...result, output: undefined } };
    }
    const path = checkedPath!;
    if (await canonicalPath(path, context.workspace) !== path) throw new Error('操作路径已变化，请重新调用工具');
    if (operation.name === 'write' || operation.name === 'edit') {
      let content: string;
      if (operation.name === 'edit') {
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        let original: string;
        try { const size = (await handle.stat()).size; if (size > 2 * 1024 * 1024) throw new Error('edit 只支持不超过 2 MiB 的文本文件'); original = await handle.readFile('utf8'); } finally { await handle.close(); }
        if (original.split(operation.oldText).length !== 2) throw new Error('oldText 必须在文件中恰好出现一次；文件未修改');
        content = original.replace(operation.oldText, () => operation.newText);
      } else content = operation.content;
      signal.throwIfAborted(); await mkdir(dirname(path), { recursive: true });
      const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
      try { signal.throwIfAborted(); await handle.writeFile(content, 'utf8'); } finally { await handle.close(); }
      return { output: `已${operation.name === 'edit' ? '修改' : '写入'} ${path}（${Buffer.byteLength(content)} bytes）`, isError: false };
    }
    if (operation.name === 'ls') {
      const entries = await readdir(path, { withFileTypes: true });
      return { output: entries.slice(0, 500).map(entry => `${entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : 'f'} ${entry.name}`).join('\n') + (entries.length > 500 ? '\n[列表已截断]' : ''), isError: false };
    }
    if (operation.name === 'find') {
      const result = await this.processes.run({ argv: [join(this.resources.bin, 'fd'), '--max-results', '256', '--absolute-path', '--type', 'f', '--print0', '--', operation.pattern, path], cwd: context.workspace, runId: context.runId, toolCallId, hostPid: context.hostPid, signal });
      const paths: string[] = [];
      for (const file of result.output.split('\0').filter(Boolean)) if (!sensitivePath(await canonicalPath(file, context.workspace), context.protectedRoots)) paths.push(file);
      return { output: paths.join('\n') + (paths.length === 256 ? '\n[最多显示 256 个文件]' : ''), isError: result.exitCode !== 0 || result.reason !== 'exit' };
    }
    const files: string[] = []; let visited = 0;
    const walk = async (file: string): Promise<void> => {
      signal.throwIfAborted(); if (++visited > 5000 || files.length >= 256 || sensitivePath(file, context.protectedRoots)) return;
      const info = await stat(file);
      if (info.isFile()) { files.push(file); return; }
      if (!info.isDirectory()) return;
      for (const entry of await readdir(file, { withFileTypes: true })) if (!entry.isSymbolicLink() && !entry.name.startsWith('.')) await walk(join(file, entry.name));
    };
    await walk(path);
    if (!files.length) return { output: '没有可搜索的文件', isError: false };
    const argv = [join(this.resources.bin, 'rg'), '--no-config', '--line-number', '--color', 'never', '--max-count', '30', ...(operation.ignoreCase ? ['--ignore-case'] : []), '--regexp', operation.pattern, '--', ...files];
    const result = await this.processes.run({ argv, cwd: context.workspace, runId: context.runId, toolCallId, hostPid: context.hostPid, signal, onOutput: observers.output });
    return { output: result.output + (files.length === 256 || visited > 5000 ? '\n[搜索文件范围已截断，请缩小目录]' : ''), isError: result.reason !== 'exit' || result.exitCode !== 0 && result.exitCode !== 1 };
  }
  cancelTool(runId: string, toolCallId: string) { for (const item of this.active) if (item.runId === runId && item.toolCallId === toolCallId) item.abort.abort(); }
  cancelRun(runId: string) { this.closed.add(runId); for (const item of this.active) if (item.runId === runId) item.abort.abort(); this.broker.cancelRun(runId); }
  stop() { for (const item of this.active) item.abort.abort(); this.broker.stop(); this.processes.stop(); }
}
