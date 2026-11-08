import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { inside } from './path-policy';
export function sessionLogDirectory(root: string, sessionId: string) {
  if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(sessionId))
    throw new Error('Invalid log identity');
  return join(root, sessionId);
}
export function toolLogDirectory(root: string, sessionId: string, toolCallId: string) {
  return join(
    sessionLogDirectory(root, sessionId),
    createHash('sha256').update(toolCallId).digest('hex'),
  );
}
export function toolLogPath(root: string, sessionId: string, runId: string, toolCallId: string) {
  sessionLogDirectory(root, runId);
  return join(toolLogDirectory(root, sessionId, toolCallId), `${runId}.log`);
}

/** Only Main may grant a read exception for an exact regular log in this session. */
export async function logReadAccess(
  { root, canonicalRoot, sessionId }: { root: string; canonicalRoot: string; sessionId: string },
  path: string,
  cwd: string,
  protectedRoots: string[],
) {
  const requested = resolve(cwd, path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);
  const actualRoot = await realpath(root);
  if (actualRoot !== canonicalRoot) throw new Error('日志根目录已变更，禁止读取');
  const base = inside(requested, resolve(root)) ? resolve(root) : actualRoot;
  const suffix = relative(sessionLogDirectory(base, sessionId), requested);
  if (!/^[a-f\d]{64}\/[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}\.log$/i.test(suffix))
    return { protectedRoots };
  const expectedPath = join(sessionLogDirectory(actualRoot, sessionId), suffix);
  if ((await realpath(requested)) !== expectedPath)
    throw new Error('日志路径已变更，禁止读取重定向日志');
  const stat = await lstat(requested);
  if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error('日志必须是限额内的普通文件');
  const canonicalRoots = await Promise.all(
    protectedRoots.map(async (value) => {
      try {
        return await realpath(value);
      } catch {
        return resolve(value);
      }
    }),
  );
  return {
    expectedPath,
    protectedRoots: protectedRoots.filter((_, index) => canonicalRoots[index] !== actualRoot),
  };
}
