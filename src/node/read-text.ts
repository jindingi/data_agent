import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { sensitivePath } from './path-policy';

export async function readText(
  workspace: string,
  protectedRoots: string[],
  params: { path: string; offset?: number; limit?: number },
  signal?: AbortSignal,
  expectedPath?: string,
) {
  const requested = resolve(workspace, params.path);
  const actual = await realpath(requested);
  if (expectedPath && actual !== expectedPath) throw new Error('操作路径已变化，请重新调用工具');
  const roots = await Promise.all(
    protectedRoots.map(async (root) => {
      try {
        return await realpath(root);
      } catch {
        return resolve(root);
      }
    }),
  );
  if (sensitivePath(requested, protectedRoots) || sensitivePath(actual, roots))
    throw new Error('禁止读取凭证或工作台控制文件');
  const file = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (expectedPath && (await realpath(actual)) !== expectedPath)
      throw new Error('操作路径已变化，请重新调用工具');
    if (!(await file.stat()).isFile()) throw new Error('只能读取普通文本文件');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const buffer = Buffer.alloc(16 * 1024);
    let scanned = 0,
      line = 1,
      output = '',
      outputBytes = 0,
      truncated = false;
    const offset = params.offset ?? 1,
      limit = params.limit ?? 200;
    outer: while (scanned < 8 * 1024 * 1024) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (!bytesRead) {
        try {
          decoder.decode();
        } catch {
          throw new Error('文件末尾不是完整的 UTF-8 文本；请使用 Python 指定实际编码读取。');
        }
        break;
      }
      scanned += bytesRead;
      const bytes = buffer.subarray(0, bytesRead);
      if (
        bytes.includes(0) ||
        (scanned === bytesRead && bytes.subarray(0, 4).equals(Buffer.from([137, 80, 78, 71])))
      )
        throw new Error(
          'read 只读取文本；检测到图片或二进制文件。可用 Python/Pillow 检查文件，图片请在产物面板查看。',
        );
      let chunk: string;
      try {
        chunk = decoder.decode(bytes, { stream: true });
      } catch {
        throw new Error(
          '文件不是有效的 UTF-8 文本；请使用 Python 指定实际编码读取。工作台不会转换或修改原文件。',
        );
      }
      for (const char of chunk) {
        if (line >= offset) {
          output += char;
          outputBytes += Buffer.byteLength(char);
        }
        if (char === '\n') line++;
        if (outputBytes >= 48 * 1024 || line >= offset + limit) {
          truncated = true;
          break outer;
        }
      }
    }
    if (scanned >= 8 * 1024 * 1024) truncated = true;
    if (line < offset && !output)
      throw new Error('未在扫描范围内找到该行；请减小 offset 或使用其他通用工具读取');
    return {
      output: output + (truncated ? `\n[读取已截断；当前到第 ${line} 行。]` : ''),
      details: { truncated, scannedBytes: scanned },
    };
  } finally {
    await file.close();
  }
}
