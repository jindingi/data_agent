import { beforeEach, afterEach, expect, it } from 'vitest';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  rm,
  open,
  readdir,
  realpath,
  stat,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { WorkspaceFileService } from '../../../src/main/services/workspace';
let root: string, work: string, files: WorkspaceFileService;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'workspace-files-')));
  work = join(root, 'work');
  await mkdir(work);
  files = new WorkspaceFileService({ get: () => ({ workspace: work }) }, [], () => false);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
it('artifacts.inventory reads real files without trusting correctness claims, manifests or links', async () => {
  await writeFile(join(work, 'report.md'), '# 1 + 1 = 9');
  await writeFile(join(work, 'empty.md'), '');
  await writeFile(join(work, 'bad.png'), 'not an image');
  await writeFile(join(root, 'outside.md'), 'outside');
  await symlink(join(root, 'outside.md'), join(work, 'escape.md'));
  await writeFile(join(work, 'manifest.json'), '{"status":"approved"}');
  const huge = await open(join(work, 'large.png'), 'w');
  await huge.truncate(25 * 1024 * 1024 + 1);
  await huge.close();
  const entries = (await files.list('s')).entries;
  expect(entries).toHaveLength(6);
  const preview = async (name: string) =>
    files.preview('s', entries.find((e) => e.name === name)!.id);
  expect((await preview('report.md')).text).toContain('1 + 1 = 9');
  expect((await preview('empty.md')).text).toBe('');
  expect((await preview('bad.png')).notice).toContain('无效');
  expect((await preview('large.png')).notice).toContain('25 MiB');
  await expect(preview('escape.md')).rejects.toThrow();
  await expect(files.preview('other', entries[0].id)).rejects.toThrow();
});
it('artifacts.shared-workspace refreshes current files and browses old directories without versions', async () => {
  await writeFile(join(work, 'report.md'), '# Earlier');
  const first = (await files.list('s')).entries[0];
  await files.saveAs('s', first.id, join(root, 'first.md'));
  await writeFile(join(work, 'report.md'), '# Later');
  const next = (await files.list('s')).entries[0];
  expect(next.id).toBe(first.id);
  expect((await files.preview('s', next.id)).text).toBe('# Later');
  expect(await readFile(join(root, 'first.md'), 'utf8')).toBe('# Earlier');
  await mkdir(join(work, 'runs/old/versions/old'), { recursive: true });
  await writeFile(join(work, 'runs/old/versions/old/report.md'), '# old');
  const old = await files.resolveLink('s', next.id, 'runs/old/versions/old/report.md');
  expect((await files.preview('s', old.id)).text).toBe('# old');
  await rm(join(work, 'report.md'));
  expect((await files.list('s')).entries.some((e) => e.name === 'report.md')).toBe(false);
});
it('artifacts.export copies large files without inventory and cleans failed staging', async () => {
  const bytes = Buffer.alloc(20 * 1024 * 1024, 37);
  await writeFile(join(work, 'large.bin'), bytes);
  const entry = (await files.list('s')).entries[0];
  const target = join(root, 'saved.bin');
  await files.saveAs('s', entry.id, target);
  expect((await stat(target)).size).toBe(bytes.length);
  expect(
    createHash('sha256')
      .update(await readFile(target))
      .digest('hex'),
  ).toBe(createHash('sha256').update(bytes).digest('hex'));
  await writeFile(join(work, 'large.bin'), 'modified');
  await expect(files.saveAs('s', entry.id, join(root, 'failed.bin'))).rejects.toThrow();
  expect((await readdir(root)).some((name) => name.endsWith('.partial'))).toBe(false);
  expect((await stat(target)).size).toBe(bytes.length);
});
