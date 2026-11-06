import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { constants, realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { LogObserver } from '../../node/process-runner';
import { inside } from '../../node/path-policy';
import { AppError } from '../../shared/errors';
import type { ToolLog, LogPage } from '../../shared/maintenance';

export class LogService {
  private canonicalRoot: string;
  constructor(private db: Database.Database, private root: string) { this.canonicalRoot = realpathSync(root); }
  register: LogObserver = ({ runId, toolCallId, path, result }) => {
    this.db.prepare(`INSERT INTO tool_logs(id,run_id,tool_call_id,path,peak_rss,reason,truncated) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(run_id,tool_call_id) DO UPDATE SET peak_rss=excluded.peak_rss,reason=excluded.reason,truncated=excluded.truncated`)
      .run(randomUUID(), runId, toolCallId, path, result?.peakRss ?? 0, result?.reason ?? null, Number(result?.truncated ?? false));
  };
  list(sessionId: string, toolCallId: string): ToolLog[] {
    const rows = this.db.prepare(`SELECT l.id,l.run_id AS runId,l.tool_call_id AS toolCallId,l.peak_rss AS peakRss,l.reason,l.truncated
      FROM tool_logs l JOIN runs r ON r.id=l.run_id WHERE r.session_id=? AND l.tool_call_id=? ORDER BY r.created_at DESC`).all(sessionId, toolCallId) as (Omit<ToolLog, 'truncated'> & { truncated: number })[];
    return rows.map(row => ({ ...row, truncated: Boolean(row.truncated) }));
  }
  async page(sessionId: string, id: string, offset: number): Promise<LogPage> {
    const row = this.db.prepare('SELECT l.path FROM tool_logs l JOIN runs r ON r.id=l.run_id WHERE l.id=? AND r.session_id=?').get(id, sessionId) as { path: string } | undefined;
    if (!row || !inside(row.path, this.root)) throw new AppError('LOG_NOT_FOUND', '日志不存在或不属于当前会话');
    try {
      if (await realpath(row.path) !== join(this.canonicalRoot, relative(this.root, row.path))) throw new Error('redirect');
      const handle = await open(row.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat(); if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error('invalid log');
        const buffer = Buffer.alloc(32 * 1024); const read = await handle.read(buffer, 0, buffer.length, offset);
        // Leave a partial UTF-8 character for the next page when possible.
        let size = read.bytesRead;
        if (offset + size < stat.size) {
          let start = size - 1; while (start >= 0 && (buffer[start] & 0xc0) === 0x80) start--;
          if (start >= 0) { const byte = buffer[start], required = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1; if (size - start < required) size = start; }
        }
        return { text: buffer.subarray(0, size).toString('utf8'), offset, nextOffset: size && offset + size < stat.size ? offset + size : null, totalBytes: stat.size };
      } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', offset: 0, nextOffset: null, totalBytes: 0 };
      throw new AppError('LOG_UNAVAILABLE', '日志路径或内容已变更，无法读取');
    }
  }
}
