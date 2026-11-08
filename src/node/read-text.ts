import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { sensitivePath } from './path-policy';
import { toolLimits } from '../shared/tool-limits';
import type { ToolOperation, ToolResult } from '../shared/tools';

export async function readText(
  workspace: string,
  protectedRoots: string[],
  params: Omit<Extract<ToolOperation, { name: 'read' }>, 'name'>,
  signal?: AbortSignal,
  expectedPath?: string,
  maxResultBytes: number = toolLimits.resultBytes,
): Promise<Pick<ToolResult, 'output' | 'details'>> {
  if (params.byteOffset !== undefined && params.offset !== undefined)
    throw new Error('offset 与 byteOffset 不能同时使用；续读请只传 byteOffset。');
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
    const info = await file.stat();
    if (!info.isFile()) throw new Error('只能读取普通文本文件');
    const start = params.byteOffset ?? 0;
    if (start > info.size) throw new Error(`byteOffset 超出文件大小（${info.size} bytes）。`);
    // Preserve the BOM while counting consumed bytes so continuation positions stay exact.
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    const buffer = Buffer.alloc(toolLimits.readChunkBytes);
    let scanned = 0,
      line = 1,
      output = '',
      outputBytes = 0,
      consumed = start,
      stoppedBy: 'bytes' | 'lines' | undefined;
    const offset = params.offset ?? 1,
      limit = params.limit ?? toolLimits.readLines;
    const maxBytes = Math.min(toolLimits.readBytes, maxResultBytes - toolLimits.resultNoticeBytes);
    if (maxBytes < 4) throw new Error('本批次工具调用过多，请减少并分批调用。');
    outer: while (scanned < toolLimits.readScanBytes) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start + scanned);
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
        (start === 0 &&
          scanned === bytesRead &&
          bytes.subarray(0, 4).equals(Buffer.from([137, 80, 78, 71])))
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
        const size = Buffer.byteLength(char);
        if (line >= offset) {
          if (outputBytes + size > maxBytes) {
            stoppedBy = 'bytes';
            break outer;
          }
          output += char;
          outputBytes += size;
        }
        consumed += size;
        if (char === '\n') line++;
        if (outputBytes >= maxBytes || line >= offset + limit) {
          stoppedBy = outputBytes >= maxBytes ? 'bytes' : 'lines';
          break outer;
        }
      }
    }
    if (line < offset && !output)
      throw new Error(
        `未在有界扫描范围内找到第 ${offset} 行；可用 byteOffset=${consumed} 从扫描终点读取，或用 Python 定位所需行。`,
      );
    const truncated = consumed < info.size;
    const nextByteOffset = truncated ? consumed : undefined;
    return {
      output:
        output +
        (truncated
          ? `\n[读取已截断；原因：${stoppedBy ?? 'scan'}；使用 byteOffset=${nextByteOffset} 继续，勿同时传 offset。]`
          : ''),
      details: {
        truncated,
        scannedBytes: scanned,
        returnedBytes: outputBytes,
        ...(nextByteOffset !== undefined
          ? { nextByteOffset, truncationReason: stoppedBy ?? 'scope' }
          : {}),
      },
    };
  } finally {
    await file.close();
  }
}
