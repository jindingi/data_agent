import { checkOutputBudget, runOutputRoot } from '../../node/output-budget';
import { open, mkdir, readdir, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { readText } from '../../node/read-text';
import { canonicalPath, sensitivePath } from '../../node/path-policy';
import type { RuntimePaths } from '../../node/runtime-paths';
import type { ProcessRunner } from '../../node/process-runner';
import type { ToolOperation, ToolResult } from '../../shared/tools';
import type { ToolContext, ToolObservers } from './tools';
/** Called only after ToolService checks policy, approval freshness, cancellation and runtime. */
export class ToolOperations {
  constructor(
    private resources: RuntimePaths,
    private processes: ProcessRunner,
  ) {}
  async execute(
    context: ToolContext,
    toolCallId: string,
    operation: Exclude<ToolOperation, { name: 'ask_clarification' }>,
    signal: AbortSignal,
    observers: ToolObservers,
    checkedPath?: string,
  ): Promise<ToolResult> {
    signal.throwIfAborted();
    if (operation.name === 'read') {
      const result = await readText(
        context.workingDirectory ?? context.workspace,
        context.protectedRoots,
        { ...operation, path: checkedPath! },
        signal,
      );
      return { ...result, isError: false };
    }
    if (operation.name === 'bash') {
      const outputRoot = runOutputRoot(context);
      await checkOutputBudget(outputRoot);
      const result = await this.processes.run({
        sessionId: context.sessionId,
        argv: ['/bin/bash', '--noprofile', '--norc', '-c', operation.command],
        outputRoot,
        cwd: context.workingDirectory ?? context.workspace,
        runId: context.runId,
        toolCallId,
        hostPid: context.hostPid,
        timeoutSeconds: operation.timeout,
        signal,
        onOutput: observers.output,
      });
      return {
        output:
          result.output +
          (result.reason !== 'exit'
            ? `\n[执行结束：${({ output_limit: '产物超过 500 MiB，已停止进程', output_entry_limit: '产物目录超过 5,000 个条目，已停止进程', output_path_changed: '产物目录路径已变更，已停止进程' } as Record<string, string>)[result.reason] ?? result.reason}]`
            : result.exitCode
              ? `\n[退出码：${result.exitCode}]`
              : ''),
        isError: result.reason !== 'exit' || result.exitCode !== 0,
        details: { ...result, output: undefined },
      };
    }
    const path = checkedPath!;
    if ((await canonicalPath(path, context.workspace)) !== path)
      throw new Error('操作路径已变化，请重新调用工具');
    if (operation.name === 'write' || operation.name === 'edit') {
      let content: string;
      if (operation.name === 'edit') {
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        let original: string;
        try {
          const size = (await handle.stat()).size;
          if (size > 2 * 1024 * 1024) throw new Error('edit 只支持不超过 2 MiB 的文本文件');
          original = await handle.readFile('utf8');
        } finally {
          await handle.close();
        }
        if (original.split(operation.oldText).length !== 2)
          throw new Error('oldText 必须在文件中恰好出现一次；文件未修改');
        content = original.replace(operation.oldText, () => operation.newText);
      } else content = operation.content;
      signal.throwIfAborted();
      await checkOutputBudget(runOutputRoot(context), { path, bytes: Buffer.byteLength(content) });
      await mkdir(dirname(path), { recursive: true });
      const handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        signal.throwIfAborted();
        await handle.writeFile(content, 'utf8');
      } finally {
        await handle.close();
      }
      return {
        output: `已${operation.name === 'edit' ? '修改' : '写入'} ${path}（${Buffer.byteLength(content)} bytes）`,
        isError: false,
      };
    }
    if (operation.name === 'ls') {
      const entries = await readdir(path, { withFileTypes: true });
      return {
        output:
          entries
            .slice(0, 500)
            .map(
              (entry) =>
                `${entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : 'f'} ${entry.name}`,
            )
            .join('\n') + (entries.length > 500 ? '\n[列表已截断]' : ''),
        isError: false,
      };
    }
    if (operation.name === 'find') {
      const result = await this.processes.run({
        sessionId: context.sessionId,
        argv: [
          join(this.resources.bin, 'fd'),
          '--max-results',
          '256',
          '--absolute-path',
          '--type',
          'f',
          '--print0',
          '--',
          operation.pattern,
          path,
        ],
        cwd: context.workingDirectory ?? context.workspace,
        runId: context.runId,
        toolCallId,
        hostPid: context.hostPid,
        signal,
      });
      const paths: string[] = [];
      for (const file of result.output.split('\0').filter(Boolean))
        if (!sensitivePath(await canonicalPath(file, context.workspace), context.protectedRoots))
          paths.push(file);
      return {
        output: paths.join('\n') + (paths.length === 256 ? '\n[最多显示 256 个文件]' : ''),
        isError: result.exitCode !== 0 || result.reason !== 'exit',
      };
    }
    const files: string[] = [];
    let visited = 0;
    const walk = async (file: string): Promise<void> => {
      signal.throwIfAborted();
      if (++visited > 5000 || files.length >= 256 || sensitivePath(file, context.protectedRoots))
        return;
      const info = await stat(file);
      if (info.isFile()) {
        files.push(file);
        return;
      }
      if (!info.isDirectory()) return;
      for (const entry of await readdir(file, { withFileTypes: true }))
        if (!entry.isSymbolicLink() && !entry.name.startsWith('.'))
          await walk(join(file, entry.name));
    };
    await walk(path);
    if (!files.length) return { output: '没有可搜索的文件', isError: false };
    const argv = [
      join(this.resources.bin, 'rg'),
      '--no-config',
      '--line-number',
      '--color',
      'never',
      '--max-count',
      '30',
      ...(operation.ignoreCase ? ['--ignore-case'] : []),
      '--regexp',
      operation.pattern,
      '--',
      ...files,
    ];
    const result = await this.processes.run({
      sessionId: context.sessionId,
      argv,
      cwd: context.workingDirectory ?? context.workspace,
      runId: context.runId,
      toolCallId,
      hostPid: context.hostPid,
      signal,
      onOutput: observers.output,
    });
    return {
      output:
        result.output +
        (files.length === 256 || visited > 5000 ? '\n[搜索文件范围已截断，请缩小目录]' : ''),
      isError: result.reason !== 'exit' || (result.exitCode !== 0 && result.exitCode !== 1),
    };
  }
}
