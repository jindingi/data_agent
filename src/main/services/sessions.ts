import type { AgentConfigService } from './agent-config';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, mkdirSync, realpathSync, statSync, rmdirSync } from 'node:fs';
import { AppError } from '../../shared/errors';
import { type SessionRecord } from '../../shared/models';
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
      if (intent) this.db.prepare('UPDATE sessions SET creation_pending=1 WHERE id=?').run(id);
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
    for (const row of this.db
      .prepare('SELECT id AS session_id FROM sessions WHERE creation_pending=1')
      .all() as {
      session_id: string;
    }[])
      this.rollbackEmpty(row.session_id);
  }
  rollbackEmpty(id: string) {
    if (this.db.prepare('SELECT run_id FROM sessions WHERE id=? AND run_id IS NOT NULL').get(id)) {
      this.db.prepare('UPDATE sessions SET creation_pending=0 WHERE id=?').run(id);
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
  sources(sessionId: string): string[] {
    this.get(sessionId);
    return (
      this.db
        .prepare('SELECT path FROM session_sources WHERE session_id=? ORDER BY path')
        .all(sessionId) as { path: string }[]
    ).map((row) => row.path);
  }
}
