import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { existsSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { AppError } from '../../shared/errors';
import { MAX_INPUT_BYTES, type SessionRecord, type FileReference } from '../../shared/models';
import { inspectSessionFile } from '../../node/session-integrity';
import type { AppPaths } from '../../node/app-paths';

type Row = Omit<SessionRecord, 'archived'> & { archived: number };
const projection =
  'id, title, workspace, session_file AS sessionFile, pi_session_id AS piSessionId, state, error, archived, created_at AS createdAt, updated_at AS updatedAt';
export class SessionService {
  constructor(
    private db: Database.Database,
    private paths: AppPaths,
    private faults?: { afterWorkspaceCreated?: () => void },
  ) {}
  list(search = '', archived = false): SessionRecord[] {
    const rows = this.db
      .prepare(`SELECT ${projection} FROM sessions WHERE archived = ? ORDER BY updated_at DESC`)
      .all(Number(archived)) as Row[];
    return rows
      .filter((r) => r.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
      .map((r) => ({ ...r, archived: Boolean(r.archived) }));
  }
  get(id: string): SessionRecord {
    const row = this.db.prepare(`SELECT ${projection} FROM sessions WHERE id=?`).get(id) as
      Row | undefined;
    if (!row) throw new AppError('SESSION_NOT_FOUND', '会话不存在');
    return { ...row, archived: Boolean(row.archived) };
  }
  create(parent = this.paths.workspace) {
    if (!statSync(parent).isDirectory()) throw new AppError('INVALID_WORKSPACE', '请选择可用目录');
    const id = randomUUID(),
      now = new Date().toISOString();
    const workspace = join(realpathSync(parent), id);
    this.db
      .prepare(
        'INSERT INTO sessions (id,title,workspace,session_file,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
      )
      .run(id, '新会话', workspace, join(this.paths.sessions, `${id}.jsonl`), 'creating', now, now);
    try {
      mkdirSync(workspace, { mode: 0o700 });
      this.faults?.afterWorkspaceCreated?.();
      this.db.prepare('UPDATE sessions SET state=? WHERE id=?').run('draft', id);
      return this.get(id);
    } catch (error) {
      // The creating intent remains durable; startup reconciliation can complete it.
      throw new AppError(
        'WORKSPACE_CREATE_FAILED',
        `无法完成工作区创建：${error instanceof Error ? error.message : '未知错误'}`,
      );
    }
  }
  private assertMutable(id: string) {
    if (this.get(id).state === 'deleting')
      throw new AppError('SESSION_UNAVAILABLE', '会话正在删除，请完成清理');
  }
  rename(id: string, title: string) {
    this.assertMutable(id);
    this.db
      .prepare('UPDATE sessions SET title=?, updated_at=? WHERE id=?')
      .run(title, new Date().toISOString(), id);
    return this.get(id);
  }
  archive(id: string, archived: boolean) {
    this.assertMutable(id);
    this.db
      .prepare('UPDATE sessions SET archived=?, updated_at=? WHERE id=?')
      .run(Number(archived), new Date().toISOString(), id);
    return this.get(id);
  }
  reconcile(id?: string) {
    const rows = id ? [this.get(id)] : [...this.list('', false), ...this.list('', true)];
    for (const row of rows) {
      if (row.state === 'deleting') continue;
      let result;
      try {
        if (row.state === 'creating' && !existsSync(row.workspace))
          mkdirSync(row.workspace, { mode: 0o700 });
        if (!statSync(row.workspace).isDirectory()) throw new Error('Not a directory');
        if (existsSync(row.sessionFile))
          this.db.prepare('UPDATE sessions SET history_known=1 WHERE id=?').run(row.id);
        const known = this.db
          .prepare('SELECT history_known FROM sessions WHERE id=?')
          .get(row.id) as { history_known: number };
        result = inspectSessionFile(row.sessionFile, row.piSessionId, Boolean(known.history_known));
      } catch {
        result = {
          state: 'unavailable',
          piSessionId: row.piSessionId,
          error: '工作区不可用，请恢复原目录。应用不会自动换一个目录。',
        };
      }
      this.db
        .prepare('UPDATE sessions SET state=?, pi_session_id=?, error=? WHERE id=?')
        .run(result.state, result.piSessionId, result.error, row.id);
    }
  }
  files(sessionId: string): FileReference[] {
    this.get(sessionId);
    const files = this.db
      .prepare(
        'SELECT id, session_id AS sessionId, path, name, size FROM file_refs WHERE session_id=? ORDER BY added_at, id',
      )
      .all(sessionId) as Omit<FileReference, 'missing'>[];
    return files.map((f) => ({ ...f, missing: !existsSync(f.path) }));
  }
  addFiles(sessionId: string, selected: string[]) {
    this.assertMutable(sessionId);
    const current = this.files(sessionId);
    const seen = new Set(current.map((f) => f.path));
    const additions: Omit<FileReference, 'missing'>[] = [];
    for (const raw of selected) {
      let path, stat;
      try {
        path = realpathSync(raw);
        stat = statSync(path);
      } catch {
        throw new AppError('FILE_NOT_FOUND', '所选文件不存在或无法访问');
      }
      if (seen.has(path)) continue;
      if (!stat.isFile() || !path.toLowerCase().endsWith('.csv'))
        throw new AppError('INVALID_FILE', '请选择 CSV 文件');
      if (stat.size > MAX_INPUT_BYTES)
        throw new AppError('INPUT_TOO_LARGE', '单个 CSV 文件不能超过 100 MB');
      additions.push({ id: randomUUID(), sessionId, path, name: basename(path), size: stat.size });
      seen.add(path);
    }
    if ([...current, ...additions].reduce((sum, f) => sum + f.size, 0) > MAX_INPUT_BYTES)
      throw new AppError('INPUT_TOO_LARGE', '选用的 CSV 总大小不能超过 100 MB');
    this.db.transaction(() => {
      const insert = this.db.prepare(
        'INSERT INTO file_refs (id,session_id,path,name,size,added_at) VALUES (?,?,?,?,?,?)',
      );
      for (const f of additions)
        insert.run(f.id, sessionId, f.path, f.name, f.size, new Date().toISOString());
    })();
    return this.files(sessionId);
  }
  removeFile(sessionId: string, fileId: string) {
    this.assertMutable(sessionId);
    this.db.prepare('DELETE FROM file_refs WHERE id=? AND session_id=?').run(fileId, sessionId);
    return this.files(sessionId);
  }
}
