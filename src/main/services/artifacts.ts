import type Database from 'better-sqlite3';
import { constants } from 'node:fs';
import { mkdir, open, readdir, realpath, writeFile } from 'node:fs/promises';
import { join, relative, dirname, extname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalPath, inside } from '../../node/path-policy';
import { AppError } from '../../shared/errors';
import type { ArtifactRecord, ArtifactListing, ArtifactPreview, OutputVersion } from '../../shared/artifacts';
import type { SessionService } from './sessions';

const MAX_VERSION_BYTES = 500 * 1024 * 1024, MAX_PNG_BYTES = 25 * 1024 * 1024, MAX_TEXT_BYTES = 2 * 1024 * 1024;
const artifactProjection = 'id,session_id AS sessionId,run_id AS runId,version_id AS versionId,path,relative_path AS relativePath,kind,state,size,sha256,error,created_at AS createdAt';
const versionProjection = 'id,session_id AS sessionId,run_id AS runId,directory,state,error,created_at AS createdAt';
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
/** File delivery and display checks only. No CSV parsing or analytical result oracle. */
export class ArtifactService {
  private scanning = new Map<string, Promise<void>>();
  constructor(private db: Database.Database, private sessions: SessionService, private decodePng: (bytes: Buffer) => boolean, private changed: (sessionId: string) => void) {}
  async createVersion(sessionId: string, runId: string): Promise<OutputVersion> {
    const session = this.sessions.get(sessionId);
    const run = this.db.prepare('SELECT session_id FROM runs WHERE id=?').get(runId) as { session_id: string } | undefined;
    if (run?.session_id !== sessionId) throw new AppError('RUN_NOT_FOUND', '任务不存在');
    const id = randomUUID(), directory = join(session.workspace, 'runs', runId, 'versions', id);
    if (await canonicalPath(directory, session.workspace) !== directory) throw new AppError('OUTPUT_PATH_CHANGED', '输出目录存在重定向，请恢复工作区目录');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const value: OutputVersion = { id, sessionId, runId, directory, state: 'open', error: null, createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO output_versions VALUES (?,?,?,?,?,?,?)').run(id, sessionId, runId, directory, value.state, null, value.createdAt);
    return value;
  }
  list(sessionId: string): ArtifactListing {
    this.sessions.get(sessionId);
    return { versions: this.db.prepare(`SELECT ${versionProjection} FROM output_versions WHERE session_id=? ORDER BY created_at DESC,id`).all(sessionId) as OutputVersion[], files: this.db.prepare(`SELECT ${artifactProjection} FROM artifacts WHERE session_id=? ORDER BY created_at DESC,relative_path`).all(sessionId) as ArtifactRecord[] };
  }
  publishedPaths(sessionId: string): string[] { return this.list(sessionId).files.map(file => file.path); }
  private version(id: string) {
    const row = this.db.prepare(`SELECT ${versionProjection} FROM output_versions WHERE id=?`).get(id) as OutputVersion | undefined;
    if (!row) throw new AppError('VERSION_NOT_FOUND', '产物版本不存在'); return row;
  }
  private file(sessionId: string, id: string) {
    this.sessions.get(sessionId);
    const row = this.db.prepare(`SELECT ${artifactProjection} FROM artifacts WHERE id=? AND session_id=?`).get(id, sessionId) as ArtifactRecord | undefined;
    if (!row) throw new AppError('ARTIFACT_NOT_FOUND', '产物不存在或不属于当前会话'); return row;
  }
  /** Only app-allocated output roots are scanned. Agent manifests are ordinary files. */
  publish(versionId: string): Promise<void> {
    const existing = this.scanning.get(versionId); if (existing) return existing;
    const task = this.scan(versionId).finally(() => this.scanning.delete(versionId)); this.scanning.set(versionId, task); return task;
  }
  private async scan(versionId: string) {
    const version = this.version(versionId); if (version.state === 'published') return;
    let bytes = 0, count = 0, scanned = 0;
    try {
      if (await realpath(version.directory) !== version.directory) throw new Error('输出目录已变更');
      const walk = async (directory: string): Promise<void> => {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (++scanned > 5000) throw new Error('输出目录条目超过 5,000 个，请减少文件数量');
          if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
          const path = join(directory, entry.name);
          if (entry.isDirectory()) { await walk(path); continue; }
          if (!entry.isFile()) continue;
          if (++count > 1000) throw new Error('产物超过 1,000 个，请减少文件数量');
          if (await realpath(path) !== path || !inside(path, version.directory)) continue;
          const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const stat = await handle.stat(); if (!stat.isFile()) continue;
            bytes += stat.size; if (bytes > MAX_VERSION_BYTES) throw new Error('本次产物超过 500 MiB，请减少输出');
            const hash = createHash('sha256'); let length = 0;
            const buffer = Buffer.alloc(64 * 1024);
            while (true) { const read = await handle.read(buffer, 0, buffer.length, null); if (!read.bytesRead) break; length += read.bytesRead; if (length > stat.size) throw new Error('产物仍在写入，请停止工具后重试'); hash.update(buffer.subarray(0, read.bytesRead)); }
            if (length !== stat.size) throw new Error('产物在登记时发生变化');
            const kind = extname(path).toLowerCase() === '.md' ? 'markdown' : extname(path).toLowerCase() === '.png' ? 'png' : 'file';
            const value: ArtifactRecord = { id: randomUUID(), sessionId: version.sessionId, runId: version.runId, versionId, path, relativePath: relative(version.directory, path), kind, state: stat.size ? 'ready' : 'empty', size: stat.size, sha256: hash.digest('hex'), error: stat.size ? null : '文件为空', createdAt: new Date().toISOString() };
            if (kind === 'png' && stat.size) {
              if (stat.size > MAX_PNG_BYTES) { value.state = 'too_large'; value.error = '图片超过 25 MiB，无法预览'; }
              else {
                const image = Buffer.alloc(stat.size); const read = await handle.read(image, 0, image.length, 0);
                if (read.bytesRead !== image.length || sha256(image) !== value.sha256) throw new Error('图片在登记时发生变化');
                const validHeader = image.length >= 33 && image.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) && image.toString('ascii', 12, 16) === 'IHDR';
                const width = validHeader ? image.readUInt32BE(16) : 0, height = validHeader ? image.readUInt32BE(20) : 0;
                if (!width || !height) { value.state = 'invalid'; value.error = '无法展示：PNG 文件无效'; }
                else if (width * height > 40_000_000) { value.state = 'too_large'; value.error = '图片超过 4,000 万像素，无法预览'; }
                else if (!this.decodePng(image)) { value.state = 'invalid'; value.error = '无法展示：PNG 解码失败'; }
              }
            }
            if (kind === 'markdown' && stat.size > MAX_TEXT_BYTES) { value.state = 'too_large'; value.error = '报告超过 2 MiB，请导出后查看'; }
            this.db.prepare('INSERT INTO artifacts VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(value.id, value.sessionId, value.runId, value.versionId, value.path, value.relativePath, value.kind, value.state, value.size, value.sha256, value.error, value.createdAt);
          } finally { await handle.close(); }
        }
      };
      await walk(version.directory);
      this.db.prepare("UPDATE output_versions SET state='published',error=NULL WHERE id=?").run(versionId);
    } catch (error) { this.db.prepare("UPDATE output_versions SET state='published',error=? WHERE id=?").run(error instanceof Error ? error.message : '无法登记产物', versionId); }
    this.changed(version.sessionId);
  }
  private async verifiedBytes(file: ArtifactRecord) {
    try {
      const version = this.version(file.versionId);
      if (await realpath(version.directory) !== version.directory || await realpath(file.path) !== file.path || !inside(file.path, version.directory)) throw new Error('文件路径已变更');
      const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat(); if (!stat.isFile() || stat.size !== file.size || stat.size > MAX_VERSION_BYTES) throw new Error('文件大小已变更');
        const buffer = Buffer.alloc(file.size + 1); let length = 0;
        while (length < buffer.length) { const result = await handle.read(buffer, length, Math.min(64 * 1024, buffer.length - length), null); if (!result.bytesRead) break; length += result.bytesRead; }
        const bytes = buffer.subarray(0, length);
        if (bytes.length !== file.size || sha256(bytes) !== file.sha256) throw new Error('文件内容已变更');
        return bytes;
      } finally { await handle.close(); }
    } catch (error) {
      const state = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'changed';
      this.db.prepare('UPDATE artifacts SET state=?,error=? WHERE id=?').run(state, state === 'missing' ? '文件已不存在' : '文件已变更，不能作为原发布版本读取', file.id);
      this.changed(file.sessionId); throw new AppError('ARTIFACT_CHANGED', state === 'missing' ? '文件已不存在' : '文件已变更，请生成新版本');
    }
  }
  async preview(sessionId: string, id: string): Promise<ArtifactPreview> {
    const file = this.file(sessionId, id);
    if (file.state !== 'ready') return { artifact: file };
    if (file.kind === 'file') return { artifact: file };
    const bytes = await this.verifiedBytes(file);
    return file.kind === 'png' ? { artifact: file, image: `data:image/png;base64,${bytes.toString('base64')}` } : { artifact: file, text: bytes.toString('utf8') };
  }
  async exportVersion(sessionId: string, versionId: string, parent: string) {
    const version = this.version(versionId); if (version.sessionId !== sessionId || version.state !== 'published') throw new AppError('VERSION_UNAVAILABLE', '该版本尚不可导出');
    const root = join(await realpath(parent), `Data-Agent-${version.id}`);
    if (inside(root, this.sessions.get(sessionId).workspace)) throw new AppError('INVALID_EXPORT', '请选择工作区外的导出目录');
    await mkdir(root, { mode: 0o700 });
    for (const file of this.list(sessionId).files.filter(file => file.versionId === versionId)) {
      const data = await this.verifiedBytes(file), target = join(root, file.relativePath);
      if (!inside(target, root)) throw new AppError('INVALID_EXPORT', '产物相对路径无效');
      await mkdir(dirname(target), { recursive: true }); await writeFile(target, data, { flag: 'wx', mode: 0o600 });
    }
    return root;
  }
  async settled() { await Promise.all([...this.scanning.values()]); }
}
