import type { AgentConfigService } from './agent-config';
import { inspectFiles } from './file-selection';
import { inputTextPreview, checkedInputPath } from './text-preview';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, mkdirSync, realpathSync, statSync, rmdirSync } from 'node:fs';
import { AppError } from '../../shared/errors';
import { type SessionRecord, type FileReference } from '../../shared/models';
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
    private agentConfigs?: AgentConfigService,
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
  create(parent = this.paths.workspace, id: string = randomUUID(), intent = false) {
    if (!statSync(parent).isDirectory()) throw new AppError('INVALID_WORKSPACE', '请选择可用目录');
    const now = new Date().toISOString();
    const workspace = join(realpathSync(parent), id);
    this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO sessions (id,title,workspace,session_file,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
        )
        .run(
          id,
          '新会话',
          workspace,
          join(this.paths.sessions, `${id}.jsonl`),
          'creating',
          now,
          now,
        );
      this.agentConfigs?.bindNew(id);
      if (intent) this.db.prepare('INSERT INTO conversation_intents VALUES (?)').run(id);
    })();
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
  recoverIntents() {
    for (const row of this.db.prepare('SELECT session_id FROM conversation_intents').all() as {
      session_id: string;
    }[])
      this.rollbackEmpty(row.session_id);
  }
  rollbackEmpty(id: string) {
    if (this.db.prepare('SELECT id FROM runs WHERE session_id=?').get(id)) {
      this.db.prepare('DELETE FROM conversation_intents WHERE session_id=?').run(id);
      return;
    }
    const session = this.get(id);
    // Never recursively delete a directory that may contain user/agent files.
    if (existsSync(session.sessionFile)) return;
    try {
      if (existsSync(session.workspace)) rmdirSync(session.workspace);
    } catch {
      return;
    }
    this.db.prepare('DELETE FROM sessions WHERE id=?').run(id);
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
  private inputReference(sessionId: string, fileId: string) {
    const file = this.files(sessionId).find((file) => file.id === fileId);
    if (!file) throw new AppError('FILE_NOT_FOUND', '文件未关联到当前会话');
    return file;
  }
  private previewProtectedRoots() {
    return [
      this.paths.sessions,
      this.paths.logs,
      this.paths.database,
      `${this.paths.database}-wal`,
      `${this.paths.database}-shm`,
    ];
  }
  previewFile(sessionId: string, fileId: string) {
    return inputTextPreview(
      this.inputReference(sessionId, fileId).path,
      this.previewProtectedRoots(),
    );
  }
  inputLocation(sessionId: string, fileId: string) {
    return checkedInputPath(
      this.inputReference(sessionId, fileId).path,
      this.previewProtectedRoots(),
    );
  }
  addFiles(sessionId: string, selected: string[]) {
    this.assertMutable(sessionId);
    const current = this.files(sessionId);
    const seen = new Set(current.map((f) => f.path));
    const additions = inspectFiles([...current.map((f) => f.path), ...selected])
      .filter((file) => !seen.has(file.path))
      .map((file) => ({ ...file, id: randomUUID(), sessionId }));
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
