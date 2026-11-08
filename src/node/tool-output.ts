import { toolLimits } from '../shared/tool-limits';
import type { ToolResult } from '../shared/tools';

/** A UTF-8 prefix whose encoded size never exceeds the requested budget. */
function utf8Prefix(text: string, maxBytes: number) {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  return new TextDecoder().decode(bytes.subarray(0, Math.max(0, maxBytes)), { stream: true });
}

/** Final defense before IPC/persistence; normal tools provide their own actionable continuation. */
export function boundToolResult(result: ToolResult, maxBytes = toolLimits.resultBytes): ToolResult {
  const bytes = Buffer.byteLength(result.output);
  if (bytes <= maxBytes) return result;
  const notice = '\n[工具结果超过本次返回预算，已截断；请缩小读取或搜索范围。]';
  const output =
    maxBytes < Buffer.byteLength(notice)
      ? utf8Prefix(notice.trim(), maxBytes)
      : utf8Prefix(result.output, maxBytes - Buffer.byteLength(notice)) + notice;
  return {
    ...result,
    output,
    details: { ...result.details, truncated: true, truncationReason: 'bytes' },
  };
}
