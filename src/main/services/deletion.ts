import type Database from 'better-sqlite3';
import { realpath, lstat, unlink, rmdir, opendir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join, relative } from 'node:path';
import { inside } from '../../node/path-policy';
import { sessionLogDirectory } from '../../node/tool-log-path';
import type { AppPaths } from '../../node/app-paths';
import type { SessionService } from './sessions';
import type { RuntimeService } from './runtime';
import type { DeletionPreview, DeletionResult } from '../../shared/maintenance';
/** Only application-owned history/logs are removed. Workspace contents are never scanned. */
export class DeletionService {
  private active = new Map<string, Promise<DeletionResult>>();
  private roots: Map<string, string>;
  constructor(
    private db: Database.Database,
    private sessions: SessionService,
    private runtime: Pick<RuntimeService, 'stopForDeletion' | 'forget'>,
    private paths: AppPaths,
    private changed: () => void,
    private faults?: { afterInternalCleanup?: () => void },
  ) {
    this.roots = new Map([paths.sessions, paths.logs].map((root) => [root, realpathSync(root)]));
  }
  preview(sessionId: string): DeletionPreview {
    const session = this.sessions.get(sessionId);
    return {
      pending: session.state === 'deleting',
      workspace: session.workspace,
      remaining:
        session.state === 'deleting' && session.error
          ? [{ path: session.sessionFile, error: session.error }]
          : [],
    };
  }
  recover() {
    for (const session of this.sessions.list('', true))
      if (session.state === 'deleting') void this.remove(session.id);
  }
  remove(sessionId: string): Promise<DeletionResult> {
    const running = this.active.get(sessionId);
    if (running) return running;
    const task = this.perform(sessionId);
    this.active.set(sessionId, task);
    void task.finally(() => this.active.delete(sessionId)).catch(() => {});
    return task;
  }
  private async clean(path: string, root: string, directories: boolean, workspaces: string[]) {
    if (
      !inside(path, root) ||
      path === root ||
      workspaces.some((workspace) => inside(path, workspace) || inside(workspace, path))
    )
      throw new Error('内部清理路径与工作区重叠，已保留');
    let stat;
    try {
      stat = await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const expected = join(this.roots.get(root)!, relative(root, path));
    if (stat.isSymbolicLink() || (await realpath(path)) !== expected)
      throw new Error('内部清理路径已重定向，已保留');
    if (stat.isFile()) {
      await unlink(path);
      return;
    }
    if (!directories || !stat.isDirectory()) throw new Error('内部清理目标类型不符，已保留');
    for await (const entry of await opendir(path))
      await this.clean(join(path, entry.name), root, true, workspaces);
    if ((await realpath(path)) !== expected) throw new Error('内部目录已重定向，已保留');
    await rmdir(path);
  }
  private async perform(sessionId: string): Promise<DeletionResult> {
    const session = this.sessions.get(sessionId);
    this.db
      .prepare("UPDATE sessions SET state='deleting',archived=1,error=NULL WHERE id=?")
      .run(sessionId);
    this.changed();
    try {
      await this.runtime.stopForDeletion(sessionId);
      const workspaces = [...this.sessions.list(), ...this.sessions.list('', true)].map(
        (row) => row.workspace,
      );
      const history = join(this.paths.sessions, `${sessionId}.jsonl`);
      if (session.sessionFile !== history) throw new Error('会话历史路径不符合应用约定');
      await this.clean(history, this.paths.sessions, false, workspaces);
      await this.clean(
        sessionLogDirectory(this.paths.logs, sessionId),
        this.paths.logs,
        true,
        workspaces,
      );
      this.faults?.afterInternalCleanup?.();
      this.db.transaction(() => {
        this.db.prepare('DELETE FROM sessions WHERE id=?').run(sessionId);
      })();
      this.runtime.forget(sessionId);
      this.changed();
      return { complete: true, remaining: [] };
    } catch (error) {
      const message = error instanceof Error ? error.message : '内部记录清理失败';
      this.db.prepare('UPDATE sessions SET error=? WHERE id=?').run(message, sessionId);
      this.changed();
      return { complete: false, remaining: [{ path: session.sessionFile, error: message }] };
    }
  }
  async settled() {
    await Promise.allSettled([...this.active.values()]);
  }
}
