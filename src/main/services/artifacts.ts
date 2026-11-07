import { readVerified, writeAll } from './artifacts-io';
import { textPreview, TEXT_PREVIEW_BYTES } from './text-preview';
import { previewLanguage } from '../../shared/file-preview';
import type Database from 'better-sqlite3';
import { constants } from 'node:fs';
import { mkdir, open, readdir, realpath, rm, rename, lstat } from 'node:fs/promises';
import { join, relative, dirname, extname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalPath, inside } from '../../node/path-policy';
import { AppError } from '../../shared/errors';
import type {
  ArtifactRecord,
  ArtifactListing,
  ArtifactPreview,
  OutputVersion,
} from '../../shared/artifacts';
import type { SessionService } from './sessions';

const MAX_VERSION_BYTES = 500 * 1024 * 1024,
  MAX_PNG_BYTES = 25 * 1024 * 1024,
  MAX_TEXT_BYTES = 2 * 1024 * 1024;
const artifactProjection =
  'id,session_id AS sessionId,run_id AS runId,version_id AS versionId,path,relative_path AS relativePath,kind,state,size,sha256,error,created_at AS createdAt';
const versionProjection =
  'id,session_id AS sessionId,run_id AS runId,directory,state,error,created_at AS createdAt';
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** File delivery and display checks only. No CSV parsing or analytical result oracle. */
export class ArtifactService {
  private scanning = new Map<string, Promise<void>>();
  private exports = new Map<string, string>();
  constructor(
    private db: Database.Database,
    private sessions: SessionService,
    private decodePng: (bytes: Buffer) => boolean,
    private changed: (sessionId: string) => void,
  ) {}
  async openWorkspace(sessionId: string, runId: string): Promise<OutputVersion> {
    const session = this.sessions.get(sessionId);
    const run = this.db.prepare('SELECT session_id FROM runs WHERE id=?').get(runId) as
      { session_id: string } | undefined;
    if (run?.session_id !== sessionId) throw new AppError('RUN_NOT_FOUND', '任务不存在');
    const directory = session.workspace;
    if ((await canonicalPath(directory, session.workspace)) !== directory)
      throw new AppError('OUTPUT_PATH_CHANGED', '输出目录存在重定向，请恢复工作区目录');
    const existing = this.db
      .prepare(
        `SELECT ${versionProjection} FROM output_versions WHERE session_id=? AND directory=?`,
      )
      .get(sessionId, directory) as OutputVersion | undefined;
    if (existing) {
      await this.scanning.get(existing.id);
      this.db
        .prepare("UPDATE output_versions SET run_id=?,state='open',error=NULL WHERE id=?")
        .run(runId, existing.id);
      this.changed(sessionId);
      return { ...existing, runId, state: 'open', error: null };
    }
    const id = randomUUID();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const value: OutputVersion = {
      id,
      sessionId,
      runId,
      directory,
      state: 'open',
      error: null,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare('INSERT INTO output_versions VALUES (?,?,?,?,?,?,?)')
      .run(id, sessionId, runId, directory, value.state, null, value.createdAt);
    return value;
  }
  list(sessionId: string): ArtifactListing {
    const { workspace } = this.sessions.get(sessionId);
    return {
      versions: this.db
        .prepare(
          `SELECT ${versionProjection} FROM output_versions WHERE session_id=? ORDER BY CASE WHEN directory=? THEN 0 ELSE 1 END,created_at DESC,id`,
        )
        .all(sessionId, workspace) as OutputVersion[],
      files: this.db
        .prepare(
          `SELECT ${artifactProjection} FROM artifacts WHERE session_id=? ORDER BY created_at DESC,relative_path`,
        )
        .all(sessionId) as ArtifactRecord[],
    };
  }
  /** Only pre-upgrade immutable versions remain protected from tool writes. */
  legacyPaths(sessionId: string): string[] {
    const workspace = this.sessions.get(sessionId).workspace;
    const listing = this.list(sessionId);
    const legacy = new Set(
      listing.versions.filter((v) => v.directory !== workspace).map((v) => v.id),
    );
    return listing.files.filter((file) => legacy.has(file.versionId)).map((file) => file.path);
  }
  private version(id: string) {
    const row = this.db
      .prepare(`SELECT ${versionProjection} FROM output_versions WHERE id=?`)
      .get(id) as OutputVersion | undefined;
    if (!row) throw new AppError('VERSION_NOT_FOUND', '产物版本不存在');
    return row;
  }
  private file(sessionId: string, id: string) {
    this.sessions.get(sessionId);
    const row = this.db
      .prepare(`SELECT ${artifactProjection} FROM artifacts WHERE id=? AND session_id=?`)
      .get(id, sessionId) as ArtifactRecord | undefined;
    if (!row) throw new AppError('ARTIFACT_NOT_FOUND', '产物不存在或不属于当前会话');
    return row;
  }
  /** Inventory the shared workspace after its writers stop. Legacy inventories remain readable. */
  publish(versionId: string): Promise<void> {
    const existing = this.scanning.get(versionId);
    if (existing) return existing;
    const task = this.scan(versionId).finally(() => this.scanning.delete(versionId));
    this.scanning.set(versionId, task);
    return task;
  }
  private async scan(versionId: string) {
    const version = this.version(versionId);
    if (version.state === 'published') return;
    const session = this.sessions.get(version.sessionId);
    const shared = version.directory === session.workspace;
    const excluded = new Set([
      ...this.sessions.files(version.sessionId).map((file) => file.path),
      ...(shared
        ? this.list(version.sessionId)
            .versions.filter((v) => v.id !== versionId)
            .map((v) => v.directory)
        : []),
    ]);
    const seen = new Set<string>();
    let bytes = 0,
      count = 0,
      scanned = 0;
    try {
      if ((await realpath(version.directory)) !== version.directory)
        throw new Error('输出目录已变更');
      const walk = async (directory: string): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (++scanned > 5000) throw new Error('输出目录条目超过 5,000 个，请减少文件数量');
          if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
          const path = join(directory, entry.name);
          if (excluded.has(path)) continue;
          if (entry.isDirectory()) {
            await walk(path);
            continue;
          }
          if (!entry.isFile()) continue;
          if (++count > 1000) throw new Error('产物超过 1,000 个，请减少文件数量');
          if ((await realpath(path)) !== path || !inside(path, version.directory)) continue;
          const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const stat = await handle.stat();
            if (!stat.isFile()) continue;
            bytes += stat.size;
            if (bytes > MAX_VERSION_BYTES) throw new Error('本次产物超过 500 MiB，请减少输出');
            const hash = createHash('sha256');
            let length = 0;
            const buffer = Buffer.alloc(64 * 1024);
            while (true) {
              const read = await handle.read(buffer, 0, buffer.length, null);
              if (!read.bytesRead) break;
              length += read.bytesRead;
              if (length > stat.size) throw new Error('产物仍在写入，请停止工具后重试');
              hash.update(buffer.subarray(0, read.bytesRead));
            }
            if (length !== stat.size) throw new Error('产物在登记时发生变化');
            const kind =
              extname(path).toLowerCase() === '.md'
                ? 'markdown'
                : extname(path).toLowerCase() === '.png'
                  ? 'png'
                  : 'file';
            const value: ArtifactRecord = {
              id: randomUUID(),
              sessionId: version.sessionId,
              runId: version.runId,
              versionId,
              path,
              relativePath: relative(version.directory, path),
              kind,
              state: stat.size ? 'ready' : 'empty',
              size: stat.size,
              sha256: hash.digest('hex'),
              error: stat.size ? null : '文件为空',
              createdAt: new Date().toISOString(),
            };
            if (kind === 'png' && stat.size) {
              if (stat.size > MAX_PNG_BYTES) {
                value.state = 'too_large';
                value.error = '图片超过 25 MiB，无法预览';
              } else {
                const image = Buffer.alloc(stat.size);
                const read = await handle.read(image, 0, image.length, 0);
                if (read.bytesRead !== image.length || sha256(image) !== value.sha256)
                  throw new Error('图片在登记时发生变化');
                const validHeader =
                  image.length >= 33 &&
                  image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
                  image.toString('ascii', 12, 16) === 'IHDR';
                const width = validHeader ? image.readUInt32BE(16) : 0,
                  height = validHeader ? image.readUInt32BE(20) : 0;
                if (!width || !height) {
                  value.state = 'invalid';
                  value.error = '无法展示：PNG 文件无效';
                } else if (width * height > 40_000_000) {
                  value.state = 'too_large';
                  value.error = '图片超过 4,000 万像素，无法预览';
                } else if (!this.decodePng(image)) {
                  value.state = 'invalid';
                  value.error = '无法展示：PNG 解码失败';
                }
              }
            }
            if (kind === 'markdown' && stat.size > MAX_TEXT_BYTES) {
              value.state = 'too_large';
              value.error = '报告超过 2 MiB，请导出后查看';
            }
            seen.add(path);
            this.db
              .prepare(
                'INSERT INTO artifacts VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(version_id,relative_path) DO UPDATE SET run_id=excluded.run_id,kind=excluded.kind,state=excluded.state,size=excluded.size,sha256=excluded.sha256,error=excluded.error',
              )
              .run(
                value.id,
                value.sessionId,
                value.runId,
                value.versionId,
                value.path,
                value.relativePath,
                value.kind,
                value.state,
                value.size,
                value.sha256,
                value.error,
                value.createdAt,
              );
          } finally {
            await handle.close();
          }
        }
      };
      await walk(version.directory);
      // Remove stale inventory only after a complete scan; a failed scan must not
      // discard records for files it never reached. Stable paths retain their IDs.
      if (shared) {
        const remove = this.db.prepare('DELETE FROM artifacts WHERE id=?');
        this.db.transaction(() => {
          for (const file of this.list(version.sessionId).files)
            if (file.versionId === versionId && !seen.has(file.path)) remove.run(file.id);
        })();
      }
      this.db
        .prepare("UPDATE output_versions SET state='published',error=NULL WHERE id=?")
        .run(versionId);
    } catch (error) {
      this.db
        .prepare("UPDATE output_versions SET state='published',error=? WHERE id=?")
        .run(error instanceof Error ? error.message : '无法登记产物', versionId);
    }
    this.changed(version.sessionId);
  }
  private async verifyRead(file: ArtifactRecord, consume: (chunk: Buffer) => Promise<void>) {
    try {
      await readVerified(file, this.version(file.versionId).directory, consume);
    } catch (error) {
      const state = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'changed';
      this.db
        .prepare('UPDATE artifacts SET state=?,error=? WHERE id=?')
        .run(
          state,
          state === 'missing' ? '文件已不存在' : '文件已变更，等待任务结束后重新登记',
          file.id,
        );
      this.changed(file.sessionId);
      throw new AppError(
        'ARTIFACT_CHANGED',
        state === 'missing' ? '文件已不存在' : '文件已变更，请等待任务结束后重试',
      );
    }
  }
  private async verifiedBytes(file: ArtifactRecord) {
    const chunks: Buffer[] = [];
    await this.verifyRead(file, async (chunk) => {
      chunks.push(Buffer.from(chunk));
    });
    return Buffer.concat(chunks);
  }
  async preview(sessionId: string, id: string): Promise<ArtifactPreview> {
    const file = this.file(sessionId, id);
    if (file.state !== 'ready') return { artifact: file };
    if (file.kind === 'file') {
      if (!previewLanguage(file.relativePath))
        return { artifact: file, notice: '暂不支持此文件格式，可在 Finder 中定位后打开。' };
      const prefix = Buffer.alloc(Math.min(file.size, TEXT_PREVIEW_BYTES));
      let offset = 0;
      // Verify the complete registered version in bounded chunks, retain only its preview prefix.
      await this.verifyRead(file, async (chunk) => {
        offset += chunk.copy(prefix, offset, 0, Math.max(0, prefix.length - offset));
      });
      return { artifact: file, ...textPreview(prefix, file.size, file.relativePath) };
    }
    const bytes = await this.verifiedBytes(file);
    return file.kind === 'png'
      ? { artifact: file, image: `data:image/png;base64,${bytes.toString('base64')}` }
      : { artifact: file, text: bytes.toString('utf8') };
  }
  async location(sessionId: string, id: string) {
    const file = this.file(sessionId, id);
    const directory = this.version(file.versionId).directory;
    if (
      (await realpath(directory)) !== directory ||
      (await realpath(file.path)) !== file.path ||
      !inside(file.path, directory)
    )
      throw new AppError('FILE_CHANGED', '文件路径已变更');
    return file.path;
  }
  async exportVersion(sessionId: string, versionId: string, parent: string) {
    const version = this.version(versionId);
    if (version.sessionId !== sessionId || version.state !== 'published')
      throw new AppError('VERSION_UNAVAILABLE', '该版本尚不可导出');
    const root = join(
      await realpath(parent),
      `Data-Agent-${version.id}-${randomUUID().slice(0, 8)}`,
    );
    if (inside(root, this.sessions.get(sessionId).workspace))
      throw new AppError('INVALID_EXPORT', '请选择工作区外的导出目录');
    // Reserve the final name exclusively. Only a hidden staging directory contains bytes until all hashes pass.
    await mkdir(root, { mode: 0o700 });
    const staging = join(root, `.partial-${randomUUID()}`);
    await mkdir(staging, { mode: 0o700 });
    const created: string[] = [];
    try {
      for (const file of this.list(sessionId).files.filter(
        (file) => file.versionId === versionId,
      )) {
        const target = join(staging, file.relativePath);
        if (!inside(target, staging)) throw new AppError('INVALID_EXPORT', '产物相对路径无效');
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        const handle = await open(target, 'wx', 0o600);
        try {
          await this.verifyRead(file, (chunk) => writeAll(handle, chunk));
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      for (const entry of await readdir(staging)) {
        const target = join(root, entry);
        // The root is exclusively allocated above; never intentionally replace an existing path.
        try {
          await lstat(target);
          throw new AppError('EXPORT_CONFLICT', '导出位置出现同名文件');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        await rename(join(staging, entry), target);
        created.push(target);
      }
      await rm(staging, { recursive: true });
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      for (const target of created) await rm(target, { recursive: true, force: true });
      // Remove only the newly reserved empty directory, never a pre-existing export.
      const { rmdir } = await import('node:fs/promises');
      await rmdir(root).catch(() => {});
      throw error;
    }
    this.exports.set(root, sessionId);
    while (this.exports.size > 64) this.exports.delete(this.exports.keys().next().value!);
    return root;
  }
  async exportLocation(sessionId: string, path: string) {
    this.sessions.get(sessionId);
    if (this.exports.get(path) !== sessionId)
      throw new AppError('EXPORT_UNAVAILABLE', '该导出位置不属于当前会话或已过期');
    if (!(await lstat(path)).isDirectory() || (await realpath(path)) !== path)
      throw new AppError('EXPORT_UNAVAILABLE', '导出目录已移动或被替换');
    return path;
  }
  async settled() {
    await Promise.all([...this.scanning.values()]);
  }
}
