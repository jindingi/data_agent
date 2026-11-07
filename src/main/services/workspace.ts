import { constants, type Stats } from 'node:fs';
import { lstat, open, opendir, realpath, rename, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inside, sensitivePath } from '../../node/path-policy';
import { AppError } from '../../shared/errors';
import type { WorkspaceEntry, WorkspaceListing, WorkspacePreview } from '../../shared/workspace';
import { textPreview, TEXT_PREVIEW_BYTES } from './text-preview';

interface Reference {
  entry: WorkspaceEntry;
  path: string;
  stat: Stats;
}
const unchanged = (a: Stats, b: Stats) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs;
/** A bounded directory view, never a persistent artifact inventory. */
export class WorkspaceFileService {
  private entries = new Map<string, Reference>();
  private roots = new Map<string, { path: string; dev: number; ino: number }>();
  constructor(
    private sessions: { get(id: string): { workspace: string } },
    private protectedRoots: string[],
    private decodePng: (bytes: Buffer) => boolean,
  ) {}
  private async root(sessionId: string) {
    const path = this.sessions.get(sessionId).workspace;
    const stat = await lstat(path);
    const previous = this.roots.get(sessionId);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (await realpath(path)) !== path ||
      sensitivePath(path, this.protectedRoots) ||
      (previous &&
        (previous.path !== path || previous.dev !== stat.dev || previous.ino !== stat.ino))
    )
      throw new AppError('WORKSPACE_CHANGED', '工作区路径已变更或不可访问，请恢复目录');
    this.roots.set(sessionId, { path, dev: stat.dev, ino: stat.ino });
    return path;
  }
  private async check(sessionId: string, path: string) {
    const root = await this.root(sessionId);
    if (
      !inside(path, root) ||
      sensitivePath(path, this.protectedRoots) ||
      (await realpath(path)) !== path
    )
      throw new AppError('FILE_DENIED', '文件路径不可访问或已重定向');
    return root;
  }
  private remember(sessionId: string, root: string, path: string, stat: Stats): WorkspaceEntry {
    const known = [...this.entries.values()].find(
      (r) => r.entry.sessionId === sessionId && r.path === path,
    );
    const entry: WorkspaceEntry = {
      id: known?.entry.id ?? randomUUID(),
      sessionId,
      name: basename(path),
      relativePath: relative(root, path),
      kind: stat.isSymbolicLink()
        ? 'unsupported'
        : stat.isDirectory()
          ? 'directory'
          : stat.isFile()
            ? 'file'
            : 'unsupported',
      size: stat.size,
      modifiedAt: stat.mtimeMs,
    };
    this.entries.delete(entry.id);
    this.entries.set(entry.id, { entry, path, stat });
    while (this.entries.size > 10000) this.entries.delete(this.entries.keys().next().value!);
    return entry;
  }
  private async reference(sessionId: string, id: string) {
    const ref = this.entries.get(id);
    if (!ref || ref.entry.sessionId !== sessionId)
      throw new AppError('FILE_NOT_FOUND', '文件条目已失效，请刷新工作区');
    await this.check(sessionId, ref.path);
    const stat = await lstat(ref.path);
    if (stat.dev !== ref.stat.dev || stat.ino !== ref.stat.ino || stat.isSymbolicLink())
      throw new AppError('FILE_CHANGED', '文件已替换，请刷新工作区');
    return ref;
  }
  async list(
    sessionId: string,
    directoryId?: string,
    showHidden = false,
  ): Promise<WorkspaceListing> {
    const root = await this.root(sessionId);
    const ref = directoryId ? await this.reference(sessionId, directoryId) : undefined;
    if (ref && ref.entry.kind !== 'directory') throw new AppError('NOT_DIRECTORY', '请选择目录');
    const path = ref?.path ?? root;
    const entries: WorkspaceEntry[] = [];
    let count = 0,
      truncated = false;
    for await (const item of await opendir(path)) {
      if (++count > 2000) {
        truncated = true;
        break;
      }
      const child = join(path, item.name);
      if ((!showHidden && item.name.startsWith('.')) || sensitivePath(child, this.protectedRoots))
        continue;
      try {
        entries.push(this.remember(sessionId, root, child, await lstat(child)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await this.check(sessionId, path);
    entries.sort(
      (a, b) =>
        Number(b.kind === 'directory') - Number(a.kind === 'directory') ||
        a.name.localeCompare(b.name),
    );
    return { entries, truncated };
  }
  async resolveLink(sessionId: string, baseId: string, href: string) {
    const base = await this.reference(sessionId, baseId);
    let link: string;
    try {
      link = decodeURIComponent(href.split(/[?#]/)[0]);
    } catch {
      throw new AppError('INVALID_LINK', '文件链接无法解析');
    }
    if (!link || /^(?:[a-z][a-z\d+.-]*:|\/|\\)/i.test(link) || link.includes('\0'))
      throw new AppError('INVALID_LINK', '只支持工作区内相对文件链接');
    const path = resolve(dirname(base.path), link);
    const root = await this.check(sessionId, path);
    return this.remember(sessionId, root, path, await lstat(path));
  }
  async location(sessionId: string, id?: string) {
    return id ? (await this.reference(sessionId, id)).path : this.root(sessionId);
  }
  private async read<T>(
    sessionId: string,
    id: string,
    consume: (handle: Awaited<ReturnType<typeof open>>, ref: Reference) => Promise<T>,
  ) {
    const ref = await this.reference(sessionId, id);
    const handle = await open(
      ref.path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const before = await handle.stat();
      if (!before.isFile()) throw new AppError('INVALID_FILE', '仅支持普通文件');
      if (!unchanged(ref.stat, before))
        throw new AppError('FILE_CHANGED', '文件内容已变化，请刷新工作区');
      const value = await consume(handle, ref);
      await this.check(sessionId, ref.path);
      if (!unchanged(before, await handle.stat()) || !unchanged(before, await lstat(ref.path)))
        throw new AppError('FILE_CHANGED', '文件正在变化，请刷新后重试');
      return value;
    } finally {
      await handle.close();
    }
  }
  async preview(sessionId: string, id: string): Promise<WorkspacePreview> {
    return this.read(sessionId, id, async (handle, ref) => {
      const suffix = extname(ref.path).toLowerCase();
      const limit =
        suffix === '.png'
          ? 25 * 1024 * 1024
          : suffix === '.md'
            ? 2 * 1024 * 1024
            : TEXT_PREVIEW_BYTES;
      if (suffix === '.png' && ref.stat.size > limit)
        return { entry: ref.entry, notice: '图片超过 25 MiB，无法预览' };
      const bytes = Buffer.alloc(Math.min(ref.stat.size, limit));
      let position = 0;
      while (position < bytes.length) {
        const { bytesRead } = await handle.read(bytes, position, bytes.length - position, position);
        if (!bytesRead) throw new AppError('FILE_CHANGED', '文件正在变化，请刷新');
        position += bytesRead;
      }
      if (suffix === '.png') {
        const valid =
          bytes.length >= 33 &&
          bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
          bytes.toString('ascii', 12, 16) === 'IHDR';
        const width = valid ? bytes.readUInt32BE(16) : 0,
          height = valid ? bytes.readUInt32BE(20) : 0;
        if (!width || !height || width * height > 40_000_000 || !this.decodePng(bytes))
          return { entry: ref.entry, notice: '图片无效或超过 4,000 万像素，无法预览' };
        return { entry: ref.entry, image: `data:image/png;base64,${bytes.toString('base64')}` };
      }
      if (suffix === '.md' && ref.stat.size <= limit) {
        try {
          return {
            entry: ref.entry,
            text: new TextDecoder('utf-8', { fatal: true }).decode(bytes),
            language: 'markdown',
          };
        } catch {
          return { entry: ref.entry, notice: '文件不是有效的 UTF-8 文本' };
        }
      }
      return {
        entry: ref.entry,
        ...textPreview(bytes.subarray(0, TEXT_PREVIEW_BYTES), ref.stat.size, ref.path),
      };
    });
  }
  async saveAs(sessionId: string, id: string, target: string) {
    const source = await this.location(sessionId, id);
    const parent = dirname(target);
    if (
      source === target ||
      sensitivePath(target, this.protectedRoots) ||
      (await realpath(parent)) !== parent
    )
      throw new AppError('INVALID_EXPORT', '不能覆盖原文件或写入敏感、重定向目录');
    const before = await lstat(target).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
      return null;
    });
    if (before && (!before.isFile() || before.isSymbolicLink()))
      throw new AppError('INVALID_EXPORT', '目标不是普通文件');
    const temp = join(parent, `.data-agent-${randomUUID()}.partial`);
    try {
      const output = await open(temp, 'wx', 0o600);
      try {
        await this.read(sessionId, id, async (input, ref) => {
          if (ref.stat.size > 500 * 1024 * 1024)
            throw new AppError('FILE_TOO_LARGE', '文件超过 500 MiB，请通过 Finder 复制');
          const buffer = Buffer.alloc(64 * 1024);
          for (let position = 0; position < ref.stat.size;) {
            const { bytesRead } = await input.read(
              buffer,
              0,
              Math.min(buffer.length, ref.stat.size - position),
              position,
            );
            if (!bytesRead) throw new AppError('FILE_CHANGED', '源文件发生变化');
            for (let offset = 0; offset < bytesRead;) {
              const { bytesWritten } = await output.write(buffer, offset, bytesRead - offset);
              if (!bytesWritten) throw new Error('无法写入文件');
              offset += bytesWritten;
            }
            position += bytesRead;
          }
        });
        await output.sync();
      } finally {
        await output.close();
      }
      const now = await lstat(target).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (
        (before ? !now || !unchanged(before, now) : now !== null) ||
        (await realpath(parent)) !== parent
      )
        throw new AppError('EXPORT_CHANGED', '保存目标发生变化，请重新选择');
      await rename(temp, target);
      return target;
    } finally {
      await unlink(temp).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
}
