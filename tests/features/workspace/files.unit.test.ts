import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceFileService } from '../../../src/main/services/workspace';
it('workspace.access lists actual files and bounds preview, identities and save destinations', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'workspace-')));
  try {
    const work = join(root, 'work');
    await mkdir(work);
    const service = new WorkspaceFileService(
      { get: (id) => ({ workspace: id === 'a' ? work : root }) },
      [],
      () => false,
    );
    await mkdir(join(work, 'nested'));
    await writeFile(join(work, 'report.md'), '# hello\n[code](nested/code.py)');
    await writeFile(join(work, 'nested/code.py'), 'print("你好")');
    await writeFile(join(work, '.env'), 'secret');
    await writeFile(join(work, 'large.csv'), 'x'.repeat(150000));
    await symlink(join(root, 'outside'), join(work, 'link'));
    const listing = await service.list('a');
    expect(listing.entries[0].name).toBe('nested');
    expect((await service.list('a', undefined, true)).entries.some((e) => e.name === '.env')).toBe(
      false,
    );
    const report = listing.entries.find((e) => e.name === 'report.md')!;
    expect((await service.preview('a', report.id)).text).toContain('# hello');
    await expect(service.preview('b', report.id)).rejects.toThrow();
    const code = await service.resolveLink('a', report.id, 'nested/code.py');
    expect((await service.preview('a', code.id)).text).toContain('你好');
    await expect(service.resolveLink('a', report.id, '../outside')).rejects.toThrow();
    await expect(service.resolveLink('a', report.id, 'file:///etc/passwd')).rejects.toThrow();
    const large = listing.entries.find((e) => e.name === 'large.csv')!;
    expect((await service.preview('a', large.id)).truncated).toBe(true);
    await service.saveAs('a', code.id, join(root, 'copy.py'));
    expect(await readFile(join(root, 'copy.py'), 'utf8')).toBe('print("你好")');
    await expect(service.saveAs('a', code.id, join(work, 'nested/code.py'))).rejects.toThrow();
    await writeFile(join(work, 'report.md'), 'changed');
    await expect(service.preview('a', report.id)).rejects.toThrow('变化');
    const refreshed = (await service.list('a')).entries.find((e) => e.name === 'report.md')!;
    expect(refreshed.id).toBe(report.id);
    expect((await service.preview('a', refreshed.id)).text).toBe('changed');
    await rm(join(work, 'report.md'));
    await symlink(join(root, 'copy.py'), join(work, 'report.md'));
    await expect(service.preview('a', refreshed.id)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
