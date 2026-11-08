import type { TSchema } from 'typebox';
import { z } from 'zod';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { toolOperationSchema, toolParameters } from '../../shared/tools';
import { toolLimits } from '../../shared/tool-limits';
import type { ToolExecutor } from '../tool-client';

const descriptions = {
  read: [
    '读取文件',
    `Read UTF-8 text, at most ${toolLimits.readLines} lines by default and ${toolLimits.readBytes / 1024} KiB. offset is a 1-based line. Continue with the returned byteOffset, including within long lines and large logs. Read larger datasets with Python.`,
  ],
  write: [
    '写入文件',
    `Write UTF-8 text, at most ${toolLimits.textBytes / 1024} KiB, creating parent directories and replacing existing contents. External writes require approval.`,
  ],
  edit: [
    '精确修改',
    `Replace exactly one occurrence of oldText with newText in a UTF-8 file no larger than ${toolLimits.editFileBytes / 1024 / 1024} MiB. Each text is limited to ${toolLimits.textBytes / 1024} KiB. Fails without changes for absent or ambiguous matches.`,
  ],
  bash: [
    '执行命令',
    `Execute bash in the session workspace. python/python3, rg and fd use bundled versions. No user shell startup files or installing dependencies. Dangerous operations are blocked; detected external writes, networking and dynamic execution request approval. Default and maximum timeout ${toolLimits.timeoutSeconds} seconds. Returns a bounded head/tail preview; output exceeding ${toolLimits.bashPreviewBytes / 1024} KiB is saved to a session log, subject to a ${toolLimits.runLogBytes / 1024 / 1024} MiB/run quota. Use read with byteOffset to inspect it.`,
  ],
  grep: [
    '搜索内容',
    `Search UTF-8 text using ripgrep regex, or literal=true for literal text. Default ${toolLimits.searchMatches} total matches. offset skips matches; continue with nextOffset. Output and traversal are bounded, and omitted scope/long lines are reported. Hidden/sensitive files and directory symlinks are excluded.`,
  ],
  find: [
    '查找文件',
    `Find regular files using an fd filename regex, default ${toolLimits.searchFiles} results. offset skips results; continue with nextOffset. Hidden/sensitive paths are excluded. Output and scanned candidates are bounded.`,
  ],
  ls: [
    '列出目录',
    `List directory entries in sorted order, default ${toolLimits.directoryEntries} entries, with file/directory/symlink type. Output is byte-bounded. offset skips entries; continue with nextOffset.`,
  ],
  ask_clarification: [
    '询问用户',
    'Ask a concise clarification question and wait for an answer. This cannot authorize filesystem or network operations.',
  ],
} satisfies Record<keyof typeof toolParameters, [string, string]>;

export function toolDeclaration(name: keyof typeof toolParameters) {
  const parameters = z.toJSONSchema(toolParameters[name], {
    target: 'draft-7',
  });
  delete parameters.$schema;
  return {
    name,
    label: descriptions[name][0],
    description: descriptions[name][1],
    parameters: parameters as TSchema,
  };
}

/** Allocate result bytes before execution; no previously sent result is rewritten. */
export class ToolBatchBudget {
  resultBytes: number = toolLimits.resultBytes;
  begin(calls: number) {
    this.resultBytes = Math.min(
      toolLimits.resultBytes,
      Math.floor(toolLimits.batchResultBytes / Math.max(1, calls)),
    );
  }
}

export function genericTools(
  client: ToolExecutor,
  redact: <T>(value: T) => T,
  budget = new ToolBatchBudget(),
): ToolDefinition[] {
  return (Object.keys(toolParameters) as (keyof typeof toolParameters)[]).map((name) => ({
    ...toolDeclaration(name),
    async execute(toolCallId, params, signal, onUpdate) {
      if (!params || typeof params !== 'object') throw new Error('工具参数必须是对象');
      const operation = toolOperationSchema.parse(redact({ ...params, name }));
      const result = await client.execute(
        toolCallId,
        operation,
        signal,
        (output) => onUpdate?.({ content: [{ type: 'text', text: output }], details: {} }),
        budget.resultBytes,
      );
      return {
        content: [{ type: 'text', text: result.output }],
        details: result.details ?? {},
        isError: result.isError,
      };
    },
  }));
}
