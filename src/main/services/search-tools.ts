import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { canonicalPath, sensitivePath } from '../../node/path-policy';
import type { ProcessRunner } from '../../node/process-runner';
import type { RuntimePaths } from '../../node/runtime-paths';
import { toolLimits } from '../../shared/tool-limits';
import type { ToolOperation, ToolResult } from '../../shared/tools';
import type { ToolContext } from './tools';

type Search = Extract<ToolOperation, { name: 'grep' | 'find' | 'ls' }>;

/** Parse complete machine records first, then format and page model-visible text. */
export class SearchTools {
  constructor(
    private resources: RuntimePaths,
    private processes: Pick<ProcessRunner, 'run'>,
  ) {}

  async execute(
    context: ToolContext,
    toolCallId: string,
    operation: Search,
    path: string,
    signal: AbortSignal,
    maxOutputBytes: number,
  ): Promise<ToolResult> {
    const offset = operation.offset ?? 0;
    if (operation.name === 'ls') {
      const entries = await readdir(path, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
      const items = entries.map(
        (entry) =>
          `${entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : 'f'} ${displayPath(entry.name)}`,
      );
      return page(items, offset, operation.limit ?? toolLimits.directoryEntries, maxOutputBytes);
    }
    let scopeTruncated = false;
    const files: string[] = [];
    if (operation.name === 'grep') {
      let visited = 0;
      const walk = async (file: string): Promise<void> => {
        signal.throwIfAborted();
        if (visited >= toolLimits.searchVisited || files.length >= toolLimits.searchFiles) {
          scopeTruncated = true;
          return;
        }
        visited++;
        if (sensitivePath(file, context.protectedRoots)) return;
        const info = await stat(file);
        if (info.isFile()) {
          files.push(file);
          return;
        }
        if (!info.isDirectory()) return;
        const entries = await readdir(file, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
        for (const entry of entries) {
          if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
          await walk(join(file, entry.name));
          if (scopeTruncated) break;
        }
      };
      await walk(path);
      if (!files.length)
        return page(
          [],
          offset,
          operation.limit ?? toolLimits.searchMatches,
          maxOutputBytes,
          scopeTruncated,
        );
    }
    const argv =
      operation.name === 'find'
        ? [
            join(this.resources.bin, 'fd'),
            '--max-results',
            String(toolLimits.searchVisited + 1),
            '--threads',
            '1',
            '--absolute-path',
            '--type',
            'f',
            '--print0',
            '--',
            operation.pattern,
            path,
          ]
        : [
            join(this.resources.bin, 'rg'),
            '--no-config',
            '--json',
            '--line-number',
            '--color',
            'never',
            '--sort',
            'path',
            ...(operation.ignoreCase ? ['--ignore-case'] : []),
            ...(operation.literal ? ['--fixed-strings'] : []),
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
      captureOutputBytes: toolLimits.searchCaptureBytes,
    });
    if (result.reason !== 'exit' && result.reason !== 'capture_limit')
      return {
        output: `搜索进程结束：${result.reason}`,
        isError: true,
        details: { reason: result.reason },
      };
    if (
      result.exitCode !== 0 &&
      !(operation.name === 'grep' && result.exitCode === 1) &&
      result.reason !== 'capture_limit'
    )
      return { output: result.output || `搜索失败，退出码 ${result.exitCode}`, isError: true };
    scopeTruncated ||= result.truncated;
    const items: string[] = [];
    let linesTruncated = false;
    if (operation.name === 'find') {
      // A byte cap may stop in a pathname. Only NUL-terminated records are paths.
      const records = result.output.split('\0').slice(0, -1);
      scopeTruncated ||= records.length > toolLimits.searchVisited;
      for (const file of records.slice(0, toolLimits.searchVisited)) {
        signal.throwIfAborted();
        if (!sensitivePath(await canonicalPath(file, context.workspace), context.protectedRoots))
          items.push(displayPath(relative(path, file)));
      }
      items.sort();
    } else {
      for (const record of result.output.split('\n').slice(0, -1)) {
        const event = JSON.parse(record) as {
          type: string;
          data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
        };
        if (
          event.type !== 'match' ||
          !event.data?.path?.text ||
          typeof event.data.line_number !== 'number'
        )
          continue;
        const text = (event.data.lines?.text ?? '[非 UTF-8 文本]').replace(/\r?\n$/, '');
        let shortened = '',
          count = 0;
        for (const char of text) {
          if (count++ === toolLimits.searchLineChars) break;
          shortened += char;
        }
        const cut = shortened.length < text.length;
        linesTruncated ||= cut;
        items.push(
          `${displayPath(event.data.path.text)}:${event.data.line_number}: ${shortened}${cut ? '…[该行截断，请用 read 定位]' : ''}`,
        );
      }
    }
    return page(
      items,
      offset,
      operation.limit ??
        (operation.name === 'find' ? toolLimits.searchFiles : toolLimits.searchMatches),
      maxOutputBytes,
      scopeTruncated,
      linesTruncated,
    );
  }
}

function displayPath(path: string) {
  return /[\r\n\t]/.test(path) ? JSON.stringify(path) : path;
}

function page(
  items: string[],
  offset: number,
  limit: number,
  maxOutputBytes: number,
  scopeTruncated = false,
  linesTruncated = false,
): ToolResult {
  const maxBytes = Math.min(toolLimits.searchBytes, maxOutputBytes - toolLimits.resultNoticeBytes);
  const selected: string[] = [];
  let bytes = 0;
  for (const item of items.slice(offset, offset + limit)) {
    const size = Buffer.byteLength(item) + (selected.length ? 1 : 0);
    if (bytes + size > maxBytes) break;
    bytes += size;
    selected.push(item);
  }
  const nextOffset = offset + selected.length;
  const more = nextOffset < items.length;
  const notices: string[] = [];
  if (more) notices.push(`结果已截断；使用 offset=${nextOffset} 继续。`);
  if (scopeTruncated)
    notices.push(
      '搜索范围已截断；当前仅覆盖有界扫描到的条目，请缩小目录或细化 pattern 取得其他结果。',
    );
  if (linesTruncated) notices.push('部分长行已截断；请用 read 的行号定位，再按 byteOffset 续读。');
  if (more && selected.length === 0)
    notices.push('当前条目超过返回预算，请缩小本批次工具调用数量。');
  return {
    output:
      (selected.length ? selected.join('\n') : '没有匹配的条目。') +
      notices.map((notice) => `\n[${notice}]`).join(''),
    isError: false,
    details: {
      truncated: more || scopeTruncated || linesTruncated,
      returnedBytes: bytes,
      scopeTruncated,
      linesTruncated,
      ...(more
        ? {
            nextOffset,
            truncationReason: selected.length >= limit ? ('entries' as const) : ('bytes' as const),
          }
        : scopeTruncated
          ? { truncationReason: 'scope' as const }
          : {}),
    },
  };
}
