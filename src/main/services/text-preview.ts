import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { canonicalPath, sensitivePath } from '../../node/path-policy';
import { previewLanguage, type TextPreview } from '../../shared/file-preview';
import { AppError } from '../../shared/errors';

export const TEXT_PREVIEW_BYTES = 128 * 1024;
const MAX_LINES = 2000;

/** Decode only a bounded prefix; never parse CSV or execute source content. */
export function textPreview(bytes: Buffer, size: number, name: string): TextPreview {
  const language = previewLanguage(name);
  if (!language) return { notice: '暂不支持此文件格式，可在 Finder 中定位后打开。' };
  if (bytes.includes(0)) return { notice: '该文件包含二进制内容，无法作为文本预览。' };
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: size > bytes.length });
  } catch {
    return { notice: '该文件不是有效的 UTF-8 文本，暂不支持此编码预览。' };
  }
  const lines = text.split('\n');
  const truncated = size > bytes.length || lines.length > MAX_LINES;
  if (lines.length > MAX_LINES) text = lines.slice(0, MAX_LINES).join('\n');
  return {
    text,
    language,
    truncated,
    notice: truncated
      ? '仅展示文件开头（最多 128 KiB / 2,000 行）；复制仅包含当前展示内容。'
      : undefined,
  };
}

export async function checkedInputPath(path: string, protectedRoots: string[]) {
  const actual = await realpath(path).catch(() => {
    throw new AppError('FILE_UNAVAILABLE', '原文件不存在或无法访问，请检查文件位置和读取权限。');
  });
  const roots = await Promise.all(protectedRoots.map((root) => canonicalPath(root, '/')));
  if (actual !== path || sensitivePath(actual, roots))
    throw new AppError('FILE_DENIED', '文件路径已变更或位于敏感目录，无法预览或定位');
  return actual;
}

export async function inputTextPreview(
  path: string,
  protectedRoots: string[],
): Promise<TextPreview> {
  await checkedInputPath(path, protectedRoots);
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch(() => {
    throw new AppError('FILE_UNAVAILABLE', '原文件不存在或无法访问，请检查文件位置和读取权限。');
  });
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new AppError('INVALID_FILE', '仅支持普通文件预览');
    const bytes = Buffer.alloc(Math.min(before.size, TEXT_PREVIEW_BYTES));
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (offset !== bytes.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new AppError('FILE_CHANGED', '文件正在变化，请重新打开预览');
    await checkedInputPath(path, protectedRoots);
    const current = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const now = await current.stat();
      if (now.ino !== before.ino || now.dev !== before.dev)
        throw new AppError('FILE_CHANGED', '文件路径已变更，请重新打开预览');
    } finally {
      await current.close();
    }
    return textPreview(bytes.subarray(0, offset), after.size, path);
  } finally {
    await handle.close();
  }
}
