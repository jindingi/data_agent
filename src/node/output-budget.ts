import { lstat, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { inside } from './path-policy';
import { executionLimits } from '../shared/tool-limits';

/** A bounded accounting pass, not an OS sandbox or a disk quota. */
export async function checkOutputBudget(
  root: string,
  replacement?: { path: string; bytes: number },
) {
  if ((await realpath(root)) !== root) throw new Error('产物目录路径已变更，未继续执行');
  let bytes = 0,
    entries = 0;
  async function walk(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (++entries > executionLimits.outputEntries)
        throw new Error('本次产物目录超过 5,000 个条目，未继续执行');
      const file = join(path, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(file);
        continue;
      }
      if (entry.isFile()) bytes += file === replacement?.path ? 0 : (await lstat(file)).size;
      if (
        bytes + (replacement && inside(replacement.path, root) ? replacement.bytes : 0) >
        executionLimits.outputBytes
      )
        throw new Error('本次产物超过 500 MiB，未继续写入或执行');
    }
  }
  await walk(root);
  if (
    bytes + (replacement && inside(replacement.path, root) ? replacement.bytes : 0) >
    executionLimits.outputBytes
  )
    throw new Error('本次产物超过 500 MiB，未继续写入或执行');
}
