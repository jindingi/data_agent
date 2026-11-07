import { previewLanguage, type TextPreview } from '../../shared/file-preview';

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
