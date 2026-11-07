import { realpath, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
export function inside(path: string, root: string) {
  const rel = relative(root, path);
  return (
    rel === '' ||
    (!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
      rel !== '..' &&
      !isAbsolute(rel))
  );
}
export function sensitivePath(path: string, protectedRoots: string[]) {
  return (
    protectedRoots.some((root) => inside(path, root)) ||
    path
      .split('/')
      .some((part) =>
        /^(?:\.env(?:\..*)?|\.ssh|\.aws|\.azure|\.gnupg|\.npmrc|\.netrc|\.pypirc|\.zshrc|\.zprofile|\.bashrc|\.bash_profile|\.kube)$/.test(
          part,
        ),
      ) ||
    [
      join(homedir(), 'Library/Keychains'),
      join(homedir(), '.config/gcloud'),
      join(homedir(), '.codex/auth.json'),
      join(homedir(), '.pi/agent/auth.json'),
    ].some((root) => inside(path, root))
  );
}
/** Resolve existing parents too, including an absent file underneath a symlink. */
export async function canonicalPath(raw: string, cwd: string): Promise<string> {
  const expanded =
    raw === '~' ? homedir() : raw.startsWith('~/') ? join(homedir(), raw.slice(2)) : raw;
  const absolute = resolve(cwd, expanded);
  try {
    return await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      if ((await lstat(absolute)).isSymbolicLink())
        throw new Error('无法解析悬空符号链接', { cause: error });
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure;
    }
    const parent = dirname(absolute);
    if (parent === absolute) throw error;
    return join(await canonicalPath(parent, cwd), basename(absolute));
  }
}
