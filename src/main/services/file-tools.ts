import { constants } from 'node:fs';
import { open, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { checkOutputBudget } from '../../node/output-budget';
import { toolLimits } from '../../shared/tool-limits';
import type { ToolOperation, ToolResult } from '../../shared/tools';

/** Exact replacement and writes share one quota check and one file-write path. */
export async function writeOrEdit(
  workspace: string,
  path: string,
  operation: Extract<ToolOperation, { name: 'write' | 'edit' }>,
  signal: AbortSignal,
): Promise<ToolResult> {
  let content: string;
  if (operation.name === 'edit') {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let original: string;
    try {
      if ((await handle.stat()).size > toolLimits.editFileBytes)
        throw new Error('edit 只支持不超过 2 MiB 的文本文件');
      original = await handle.readFile('utf8');
    } finally {
      await handle.close();
    }
    const start = original.indexOf(operation.oldText);
    if (start < 0 || original.indexOf(operation.oldText, start + 1) !== -1)
      throw new Error('oldText 必须在文件中恰好出现一次；文件未修改');
    content =
      original.slice(0, start) +
      operation.newText +
      original.slice(start + operation.oldText.length);
  } else content = operation.content;
  signal.throwIfAborted();
  await checkOutputBudget(workspace, { path, bytes: Buffer.byteLength(content) });
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
