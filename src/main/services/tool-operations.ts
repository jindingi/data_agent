import { checkOutputBudget } from '../../node/output-budget';
import { readText } from '../../node/read-text';
import { canonicalPath } from '../../node/path-policy';
import { toolLimits } from '../../shared/tool-limits';
import type { RuntimePaths } from '../../node/runtime-paths';
import type { ProcessRunner } from '../../node/process-runner';
import type { ToolOperation, ToolResult } from '../../shared/tools';
import type { ToolContext, ToolObservers } from './tools';
import { writeOrEdit } from './file-tools';
import { SearchTools } from './search-tools';

/** Dispatch only checked operations; policy, approval and cancellation remain in ToolService. */
export class ToolOperations {
  private search: SearchTools;
  constructor(
    resources: RuntimePaths,
    private processes: Pick<ProcessRunner, 'run'>,
  ) {
    this.search = new SearchTools(resources, processes);
  }
  async execute(
    context: ToolContext,
    toolCallId: string,
    operation: Exclude<ToolOperation, { name: 'ask_clarification' }>,
    signal: AbortSignal,
    observers: ToolObservers,
    checkedPath?: string,
    maxOutputBytes: number = toolLimits.resultBytes,
  ): Promise<ToolResult> {
    signal.throwIfAborted();
    if (operation.name === 'bash') {
      await checkOutputBudget(context.workspace);
      const result = await this.processes.run({
        sessionId: context.sessionId,
        argv: ['/bin/bash', '--noprofile', '--norc', '-c', operation.command],
        outputRoot: context.workspace,
        cwd: context.workingDirectory ?? context.workspace,
        runId: context.runId,
        toolCallId,
        hostPid: context.hostPid,
        timeoutSeconds: operation.timeout,
        signal,
        onOutput: observers.output,
        saveOverflowLog: true,
      });
      const { output, ...details } = result;
      const reasons: Record<string, string> = {
        output_limit: '产物超过 500 MiB，已停止进程',
        output_entry_limit: '产物目录超过 5,000 个条目，已停止进程',
        output_path_changed: '产物目录路径已变更，已停止进程',
      };
      return {
        output:
          output +
          (result.reason !== 'exit'
            ? `\n[执行结束：${reasons[result.reason] ?? result.reason}]`
            : result.exitCode
              ? `\n[退出码：${result.exitCode}]`
              : ''),
        isError: result.reason !== 'exit' || result.exitCode !== 0,
        details,
      };
    }
    if (!checkedPath || (await canonicalPath(checkedPath, context.workspace)) !== checkedPath)
      throw new Error('操作路径已变化，请重新调用工具');
    switch (operation.name) {
      case 'read':
        return {
          ...(await readText(
            context.workingDirectory ?? context.workspace,
            context.protectedRoots,
            { ...operation, path: checkedPath },
            signal,
            checkedPath,
            maxOutputBytes,
          )),
          isError: false,
        };
      case 'write':
      case 'edit':
        return writeOrEdit(context.workspace, checkedPath, operation, signal);
      case 'ls':
      case 'find':
      case 'grep':
        return this.search.execute(
          context,
          toolCallId,
          operation,
          checkedPath,
          signal,
          maxOutputBytes,
        );
      default: {
        const exhaustive: never = operation;
        throw new Error(`未知工具：${String(exhaustive)}`);
      }
    }
  }
}
