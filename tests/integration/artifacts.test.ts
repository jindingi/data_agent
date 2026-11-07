import { beforeEach, afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { getAppPaths, ensureAppPaths } from '../../src/node/app-paths';
import { openDatabase } from '../../src/main/storage/database';
import { SessionService } from '../../src/main/services/sessions';
import { ArtifactService } from '../../src/main/services/artifacts';
import { PolicyService } from '../../src/main/services/policy';
import { getRuntimePaths } from '../../src/node/runtime-paths';

let root: string,
  db: ReturnType<typeof openDatabase>,
  sessions: SessionService,
  artifacts: ArtifactService,
  sessionId: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'data-agent-artifacts-'));
  const paths = getAppPaths(
    { DATA_AGENT_HOME: join(root, 'data'), DATA_AGENT_USER_DATA: join(root, 'user') },
    true,
  );
  ensureAppPaths(paths);
  db = openDatabase(paths.database);
  sessions = new SessionService(db, paths);
  sessionId = sessions.create().id;
  artifacts = new ArtifactService(
    db,
    sessions,
    () => false,
    () => {},
  );
});
afterEach(async () => {
  await artifacts.settled();
  db.close();
  await rm(root, { recursive: true, force: true });
});
async function version() {
  const id = randomUUID();
  db.prepare('INSERT INTO runs VALUES (?,?,?,?,?,?,?,NULL)').run(
    id,
    sessionId,
    randomUUID(),
    'completed',
    'test',
    'test',
    new Date().toISOString(),
  );
  return artifacts.createVersion(sessionId, id);
}
it('P4-ARTIFACT registers actual bounded files without trusting agent manifests or correctness claims', async () => {
  const v = await version();
  await writeFile(join(v.directory, 'report.md'), '# Clearly incorrect arithmetic\n\n1 + 1 = 9\n');
  await writeFile(join(v.directory, 'empty.md'), '');
  await writeFile(join(v.directory, 'bad.png'), 'not an image');
  await writeFile(join(root, 'outside.md'), 'outside');
  await symlink(join(root, 'outside.md'), join(v.directory, 'escape.md'));
  await writeFile(
    join(v.directory, 'manifest.json'),
    JSON.stringify({ status: 'approved', report: join(root, 'outside.md'), id: 'forged-id' }),
  );
  const oversized = await open(join(v.directory, 'large.png'), 'w');
  await oversized.truncate(25 * 1024 * 1024 + 1);
  await oversized.close();
  await artifacts.publish(v.id);
  const listing = artifacts.list(sessionId);
  expect(listing.files).toHaveLength(5);
  expect(listing.files.every((file) => file.id !== 'forged-id')).toBe(true);
  expect(listing.files.find((file) => file.relativePath === 'bad.png')!.state).toBe('invalid');
  expect(listing.files.find((file) => file.relativePath === 'empty.md')!.state).toBe('empty');
  expect(listing.files.find((file) => file.relativePath === 'large.png')!.state).toBe('too_large');
  const report = listing.files.find((file) => file.relativePath === 'report.md')!;
  expect(report.state).toBe('ready');
  expect((await artifacts.preview(sessionId, report.id)).text).toContain('1 + 1 = 9');
  const other = sessions.create();
  await expect(artifacts.preview(other.id, report.id)).rejects.toThrow('不属于当前会话');
  await artifacts.publish(v.id);
  expect(artifacts.list(sessionId).files).toHaveLength(5);
  await writeFile(report.path, 'changed externally');
  await expect(artifacts.preview(sessionId, report.id)).rejects.toThrow('文件已变更');
  expect(artifacts.list(sessionId).files.find((file) => file.id === report.id)!.state).toBe(
    'changed',
  );
});
it('P4-VERSIONS preserves earlier bytes and IDs, guards their writes, and exports relative files', async () => {
  const first = await version();
  await mkdir(join(first.directory, 'figures'));
  await writeFile(join(first.directory, 'report.md'), '# Earlier\n\n[Data](figures/table.csv)\n');
  await writeFile(join(first.directory, 'figures/table.csv'), 'x\n1\n');
  await artifacts.publish(first.id);
  const original = artifacts
    .list(sessionId)
    .files.find((file) => file.relativePath === 'report.md')!;
  const second = await version();
  await writeFile(join(second.directory, 'report.md'), '# New report');
  await artifacts.publish(second.id);
  const list = artifacts.list(sessionId);
  const reports = list.files.filter((file) => file.relativePath === 'report.md');
  expect(reports).toHaveLength(2);
  expect(new Set(reports.map((file) => file.id)).size).toBe(2);
  expect(new Set(reports.map((file) => file.path)).size).toBe(2);
  expect(await readFile(original.path, 'utf8')).toContain('# Earlier');
  expect((await artifacts.preview(sessionId, original.id)).artifact.sha256).toBe(original.sha256);
  const policy = new PolicyService(getRuntimePaths(process.cwd(), '', false));
  const context = {
    workspace: sessions.get(sessionId).workspace,
    workingDirectory: second.directory,
    protectedRoots: [],
    inputs: [],
    published: artifacts.publishedPaths(sessionId),
  };
  expect(
    (await policy.inspect(context, { name: 'write', path: original.path, content: 'overwrite' }))
      .decision,
  ).toBe('deny');
  const exported = await artifacts.exportVersion(sessionId, first.id, root);
  expect(await readFile(join(exported, 'report.md'), 'utf8')).toContain('figures/table.csv');
  expect(await readFile(join(exported, 'figures/table.csv'), 'utf8')).toBe('x\n1\n');
  await expect(artifacts.exportVersion(sessions.create().id, first.id, root)).rejects.toThrow(
    '尚不可导出',
  );
  await rm(original.path);
  await expect(artifacts.preview(sessionId, original.id)).rejects.toThrow('不存在');
  expect(artifacts.list(sessionId).files.find((file) => file.id === original.id)!.state).toBe(
    'missing',
  );
});

it('R-EXPORT streams large artifacts in bounded chunks, preserves exports and cleans failed staging', async () => {
  const { createHash } = await import('node:crypto');
  const { readVerified } = await import('../../src/main/services/artifacts-io');
  const { stat } = await import('node:fs/promises');
  const v = await version(),
    path = join(v.directory, 'large.bin');
  const chunk = Buffer.alloc(64 * 1024, 37),
    hash = createHash('sha256');
  const handle = await open(path, 'w');
  try {
    for (let i = 0; i < 320; i++) {
      await handle.write(chunk);
      hash.update(chunk);
    }
  } finally {
    await handle.close();
  }
  await artifacts.publish(v.id);
  const file = artifacts.list(sessionId).files.find((f) => f.versionId === v.id)!;
  let largest = 0,
    total = 0;
  const readHash = createHash('sha256');
  await readVerified(file, v.directory, async (part) => {
    largest = Math.max(largest, part.length);
    total += part.length;
    readHash.update(part);
  });
  expect(largest).toBeLessThanOrEqual(64 * 1024);
  expect(total).toBe(20 * 1024 * 1024);
  expect(readHash.digest('hex')).toBe(hash.digest('hex'));
  const exported = await artifacts.exportVersion(sessionId, v.id, root);
  expect((await stat(join(exported, 'large.bin'))).size).toBe(total);
  await expect(artifacts.exportVersion(sessionId, v.id, root)).rejects.toThrow();
  const broken = await version();
  await writeFile(join(broken.directory, 'report.md'), 'before');
  await artifacts.publish(broken.id);
  await writeFile(join(broken.directory, 'report.md'), 'changed');
  await expect(artifacts.exportVersion(sessionId, broken.id, root)).rejects.toThrow('变更');
  await expect(stat(join(root, `Data-Agent-${broken.id}`))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect((await stat(join(exported, 'large.bin'))).size).toBe(total);
});
