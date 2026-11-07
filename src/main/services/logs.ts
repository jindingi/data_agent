import { randomUUID } from 'node:crypto';
import { open, realpath, opendir } from 'node:fs/promises';
import { constants, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { toolLogDirectory } from '../../node/tool-log-path';
import { AppError } from '../../shared/errors';
import type { ToolLog, LogPage } from '../../shared/maintenance';
export class LogService {
  private canonicalRoot: string;
  private entries = new Map<string, { path: string; sessionId: string; toolCallId: string }>();
  constructor(
    private root: string,
    private authorized: (sessionId: string, toolCallId: string) => Promise<boolean>,
  ) {
    this.canonicalRoot = realpathSync(root);
  }
  async list(sessionId: string, toolCallId: string): Promise<ToolLog[]> {
    if (!(await this.authorized(sessionId, toolCallId)))
      throw new AppError('LOG_NOT_FOUND', '工具不属于当前会话');
    const directory = toolLogDirectory(this.root, sessionId, toolCallId);
    try {
      if ((await realpath(directory)) !== join(this.canonicalRoot, relative(this.root, directory)))
        throw new Error('redirect');
      const rows: ToolLog[] = [];
      for await (const item of await opendir(directory)) {
        if (rows.length >= 100) break;
        if (!item.isFile() || !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}\.log$/i.test(item.name))
          continue;
        const id = randomUUID();
        this.entries.set(id, { sessionId, toolCallId, path: join(directory, item.name) });
        rows.push({ id, runId: item.name.slice(0, -4), toolCallId });
      }
      while (this.entries.size > 1000) this.entries.delete(this.entries.keys().next().value!);
      return rows;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new AppError('LOG_UNAVAILABLE', '日志目录已变更，无法读取');
    }
  }
  async page(sessionId: string, id: string, offset: number): Promise<LogPage> {
    const row = this.entries.get(id);
    if (!row || row.sessionId !== sessionId || !(await this.authorized(sessionId, row.toolCallId)))
      throw new AppError('LOG_NOT_FOUND', '日志不存在或不属于当前会话');
    try {
      if ((await realpath(row.path)) !== join(this.canonicalRoot, relative(this.root, row.path)))
        throw new Error('redirect');
      const handle = await open(row.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error('invalid log');
        const buffer = Buffer.alloc(32 * 1024);
        const read = await handle.read(buffer, 0, buffer.length, offset);
        // Leave a partial UTF-8 character for the next page when possible.
        let size = read.bytesRead;
        if (offset + size < stat.size) {
          let start = size - 1;
          while (start >= 0 && (buffer[start] & 0xc0) === 0x80) start--;
          if (start >= 0) {
            const byte = buffer[start],
              required = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
            if (size - start < required) size = start;
          }
        }
        return {
          text: buffer.subarray(0, size).toString('utf8'),
          offset,
          nextOffset: size && offset + size < stat.size ? offset + size : null,
          totalBytes: stat.size,
        };
      } finally {
        await handle.close();
      }
    } catch (error) {
      throw new AppError('LOG_UNAVAILABLE', '日志路径或内容已变更，无法读取');
    }
  }
}
