import { constants } from 'node:fs';
import { open, realpath, type FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { inside } from '../../node/path-policy';
import type { ArtifactRecord } from '../../shared/artifacts';
/** Uses one verified descriptor and bounded chunks for both preview and export. */
export async function readVerified(
  file: ArtifactRecord,
  directory: string,
  consume: (chunk: Buffer) => Promise<void>,
) {
  if (
    (await realpath(directory)) !== directory ||
    (await realpath(file.path)) !== file.path ||
    !inside(file.path, directory)
  )
    throw new Error('文件路径已变更');
  const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const initial = await handle.stat();
    if (!initial.isFile() || initial.size !== file.size || initial.size > 500 * 1024 * 1024)
      throw new Error('文件大小已变更');
    const hash = createHash('sha256'),
      buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > file.size) throw new Error('文件大小已变更');
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      await consume(chunk);
    }
    const final = await handle.stat();
    if (
      total !== file.size ||
      hash.digest('hex') !== file.sha256 ||
      initial.ino !== final.ino ||
      initial.mtimeMs !== final.mtimeMs ||
      (await realpath(file.path)) !== file.path
    )
      throw new Error('文件内容已变更');
    const pathHandle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const now = await pathHandle.stat();
      if (now.ino !== initial.ino || now.dev !== initial.dev) throw new Error('文件路径已变更');
    } finally {
      await pathHandle.close();
    }
  } finally {
    await handle.close();
  }
}
export async function writeAll(handle: FileHandle, chunk: Buffer) {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
    if (!bytesWritten) throw new Error('无法完成导出写入');
    offset += bytesWritten;
  }
}
