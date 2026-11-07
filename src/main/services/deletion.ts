import type Database from 'better-sqlite3';
import { open, realpath, lstat, unlink, rmdir } from 'node:fs/promises';
import { constants, realpathSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { inside, canonicalPath } from '../../node/path-policy';
import type { AppPaths } from '../../node/app-paths';
import type { SessionService } from './sessions';
import type { ArtifactService } from './artifacts';
import type { RuntimeService } from './runtime';
import type { DeletionPreview, DeletionResult } from '../../shared/maintenance';

interface Target {
  path: string;
  kind: string;
  sha256: string | null;
  state: string;
  error: string | null;
}
/** Durable, explicit file inventory. Never recursively remove a workspace or follow links. */
export class DeletionService {
  private active = new Map<string, Promise<DeletionResult>>();
  private roots: Map<string, string>;
  constructor(
    private db: Database.Database,
    private sessions: SessionService,
    private runtime: Pick<RuntimeService, 'stopForDeletion' | 'forget'>,
    private artifacts: ArtifactService,
    private paths: AppPaths,
    private changed: () => void,
  ) {
    this.roots = new Map([paths.sessions, paths.logs].map((root) => [root, realpathSync(root)]));
  }
  preview(sessionId: string): DeletionPreview {
    const session = this.sessions.get(sessionId);
    const job = this.db
      .prepare('SELECT delete_artifacts FROM deletion_jobs WHERE session_id=?')
      .get(sessionId) as { delete_artifacts: number } | undefined;
    return {
      pending: Boolean(job),
      deleteArtifacts: Boolean(job?.delete_artifacts),
      workspace: session.workspace,
      artifactCount: this.artifacts.list(sessionId).files.length,
      remaining: this.remaining(sessionId),
    };
  }
  private remaining(id: string) {
    return this.db
      .prepare(
        "SELECT path,error FROM deletion_files WHERE session_id=? AND state!='removed' ORDER BY path",
      )
      .all(id) as DeletionResult['remaining'];
  }
  remove(sessionId: string, deleteArtifacts: boolean): Promise<DeletionResult> {
    const running = this.active.get(sessionId);
    if (running) return running;
    const task = this.perform(sessionId, deleteArtifacts);
    this.active.set(sessionId, task);
    void task.then(
      () => this.active.delete(sessionId),
      () => this.active.delete(sessionId),
    );
    return task;
  }
  private async hash(path: string) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await handle.stat()).isFile()) throw new Error('目标不是普通文件，已保留');
      const hash = createHash('sha256'),
        buffer = Buffer.alloc(64 * 1024);
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (!bytesRead) break;
        hash.update(buffer.subarray(0, bytesRead));
      }
      return hash.digest('hex');
    } finally {
      await handle.close();
    }
  }
  private async perform(sessionId: string, deleteArtifacts: boolean): Promise<DeletionResult> {
    const session = this.sessions.get(sessionId);
    this.db.transaction(() => {
      this.db
        .prepare('INSERT OR IGNORE INTO deletion_jobs(session_id,delete_artifacts) VALUES (?,?)')
        .run(sessionId, Number(deleteArtifacts));
      this.db
        .prepare(
          "UPDATE sessions SET state='deleting',archived=1,error='会话正在删除；部分失败时可重新打开并继续清理。' WHERE id=?",
        )
        .run(sessionId);
    })();
    this.changed();
    try {
      await this.runtime.stopForDeletion(sessionId);
      await this.artifacts.settled();
      const job = this.db
        .prepare('SELECT delete_artifacts,prepared FROM deletion_jobs WHERE session_id=?')
        .get(sessionId) as { delete_artifacts: number; prepared: number };
      if (!job.prepared) {
        const targets: { path: string; kind: string; sha256: string | null }[] = [
          { path: session.sessionFile, kind: 'history', sha256: null },
        ];
        const originals = new Set(
          (
            this.db
              .prepare('SELECT path FROM file_refs UNION SELECT path FROM run_files')
              .all() as { path: string }[]
          ).map((row) => row.path),
        );
        if (job.delete_artifacts)
          targets.push(
            ...this.artifacts
              .list(sessionId)
              .files.filter((file) => !originals.has(file.path))
              .map((file) => ({ path: file.path, kind: 'artifact', sha256: file.sha256 })),
          );
        targets.push(
          ...(
            this.db
              .prepare(
                'SELECT path FROM tool_logs WHERE run_id IN (SELECT id FROM runs WHERE session_id=?)',
              )
              .all(sessionId) as { path: string }[]
          ).map((row) => ({ ...row, kind: 'log', sha256: null })),
        );
        this.db.transaction(() => {
          const insert = this.db.prepare(
            'INSERT OR IGNORE INTO deletion_files(session_id,path,kind,sha256) VALUES (?,?,?,?)',
          );
          for (const target of targets)
            insert.run(sessionId, target.path, target.kind, target.sha256);
          this.db.prepare('UPDATE deletion_jobs SET prepared=1 WHERE session_id=?').run(sessionId);
        })();
      }
      const targets = this.db
        .prepare(
          "SELECT path,kind,sha256,state,error FROM deletion_files WHERE session_id=? AND state!='removed'",
        )
        .all(sessionId) as Target[];
      for (const target of targets) {
        try {
          const root =
            target.kind === 'history'
              ? this.paths.sessions
              : target.kind === 'log'
                ? this.paths.logs
                : session.workspace;
          if (
            !inside(target.path, root) ||
            target.path === root ||
            (target.kind === 'history' &&
              target.path !== join(this.paths.sessions, `${sessionId}.jsonl`))
          )
            throw new Error('目标不在登记的应用路径内，已保留');
          const expected = join(this.roots.get(root) ?? root, relative(root, target.path));
          if ((await canonicalPath(target.path, root)) !== expected)
            throw new Error('路径已重定向，已保留');
          let exists = true;
          try {
            const stat = await lstat(target.path);
            if (!stat.isFile() || stat.isSymbolicLink())
              throw new Error('目标已替换为非普通文件，已保留');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false;
            else throw error;
          }
          if (exists) {
            const hash = await this.hash(target.path);
            if (target.sha256 && target.sha256 !== hash)
              throw new Error('文件在登记后已变更，已保留；请检查后手动处理再重试');
            if (!target.sha256)
              this.db
                .prepare('UPDATE deletion_files SET sha256=? WHERE session_id=? AND path=?')
                .run(hash, sessionId, target.path);
            if ((await realpath(target.path)) !== expected) throw new Error('路径已变更，已保留');
            await unlink(target.path);
          }
          this.db
            .prepare(
              "UPDATE deletion_files SET state='removed',error=NULL WHERE session_id=? AND path=?",
            )
            .run(sessionId, target.path);
          // Empty registered ancestors only; nonempty directories and the external parent survive.
          if (target.kind === 'artifact')
            for (
              let dir = dirname(target.path);
              inside(dir, session.workspace);
              dir = dirname(dir)
            ) {
              try {
                if ((await realpath(dir)) !== dir) break;
                await rmdir(dir);
              } catch {
                break;
              }
              if (dir === session.workspace) break;
            }
        } catch (error) {
          this.db
            .prepare(
              "UPDATE deletion_files SET state='failed',error=? WHERE session_id=? AND path=?",
            )
            .run(error instanceof Error ? error.message : '清理失败', sessionId, target.path);
        }
      }
      const remaining = this.remaining(sessionId);
      if (remaining.length) {
        this.changed();
        return { complete: false, remaining };
      }
      this.db.transaction(() => {
        for (const table of ['tool_logs', 'run_files', 'run_inputs'])
          this.db
            .prepare(
              `DELETE FROM ${table} WHERE run_id IN (SELECT id FROM runs WHERE session_id=?)`,
            )
            .run(sessionId);
        for (const table of ['artifacts', 'output_versions', 'interactions', 'runs'])
          this.db.prepare(`DELETE FROM ${table} WHERE session_id=?`).run(sessionId);
        this.db.prepare('DELETE FROM sessions WHERE id=?').run(sessionId);
      })();
      this.runtime.forget(sessionId);
      this.changed();
      return { complete: true, remaining: [] };
    } catch (error) {
      const message = error instanceof Error ? error.message : '删除准备失败';
      this.db
        .prepare('UPDATE sessions SET error=? WHERE id=?')
        .run(`删除尚未完成：${message}`, sessionId);
      this.changed();
      return { complete: false, remaining: [{ path: session.workspace, error: message }] };
    }
  }
  async settled() {
    await Promise.allSettled([...this.active.values()]);
  }
}
