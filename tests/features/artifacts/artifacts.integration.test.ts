import { beforeEach, afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, open } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { getAppPaths, ensureAppPaths } from '../../../src/node/app-paths';
import { openDatabase } from '../../../src/main/storage/database';
import { SessionService } from '../../../src/main/services/sessions';
import { ArtifactService } from '../../../src/main/services/artifacts';
import { PolicyService } from '../../../src/main/services/policy';
import { getRuntimePaths } from '../../../src/node/runtime-paths';

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
  return artifacts.openWorkspace(sessionId, id);
}
it('artifacts.inventory registers actual bounded files without trusting agent manifests or correctness claims', async () => {
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
  const textVersion = await version();
  const source = 'x'.repeat(200_000);
  await writeFile(join(textVersion.directory, 'large.py'), source);
  await artifacts.publish(textVersion.id);
  const code = artifacts.list(sessionId).files.find((file) => file.relativePath === 'large.py')!;
  const preview = await artifacts.preview(sessionId, code.id);
  expect(preview.text).toBe(source.slice(0, 128 * 1024));
  expect(preview.truncated).toBe(true);
  // Even a change beyond the displayed prefix must invalidate the registered version.
  await writeFile(code.path, source.slice(0, -1) + 'y');
  await expect(artifacts.preview(sessionId, code.id)).rejects.toThrow('文件已变更');
});
it('artifacts.shared-workspace reuses the session workspace, refreshes changed files and preserves legacy output', async () => {
  const first = await version();
  expect(first.directory).toBe(sessions.get(sessionId).workspace);
  await mkdir(join(first.directory, 'figures'));
  await writeFile(join(first.directory, 'report.md'), '# Earlier');
  await writeFile(join(first.directory, 'obsolete.txt'), 'remove me');
  await writeFile(join(first.directory, 'figures/table.csv'), 'x\n1\n');
  await artifacts.publish(first.id);
  const original = artifacts
    .list(sessionId)
    .files.find((file) => file.relativePath === 'report.md')!;
  const firstExport = await artifacts.exportVersion(sessionId, first.id, root);
  const second = await version();
  expect(second.id).toBe(first.id);
  expect(second.directory).toBe(first.directory);
  const policy = new PolicyService(getRuntimePaths(process.cwd(), '', false));
  const context = {
    workspace: sessions.get(sessionId).workspace,
    workingDirectory: second.directory,
    protectedRoots: [],
    inputs: [],
    published: artifacts.legacyPaths(sessionId),
  };
  expect(
    (await policy.inspect(context, { name: 'write', path: original.path, content: 'overwrite' }))
      .decision,
  ).toBe('allow');
  await writeFile(
    join(second.directory, 'report.md'),
    '# New report\n\n[Data](figures/table.csv)\n',
  );
  await rm(join(second.directory, 'obsolete.txt'));
  await artifacts.publish(second.id);
  const list = artifacts.list(sessionId);
  expect(list.versions).toHaveLength(1);
  const reports = list.files.filter((file) => file.relativePath === 'report.md');
  expect(reports).toHaveLength(1);
  expect(reports[0].id).toBe(original.id);
  expect(reports[0].sha256).not.toBe(original.sha256);
  expect(reports[0].runId).toBe(second.runId);
  expect(list.files.some((file) => file.relativePath === 'obsolete.txt')).toBe(false);
  expect((await artifacts.preview(sessionId, original.id)).text).toContain('# New report');
  const exported = await artifacts.exportVersion(sessionId, second.id, root);
  expect(await readFile(join(exported, 'figures/table.csv'), 'utf8')).toBe('x\n1\n');
  expect(await readFile(join(firstExport, 'report.md'), 'utf8')).toBe('# Earlier');
  await expect(artifacts.exportVersion(sessions.create().id, second.id, root)).rejects.toThrow(
    '尚不可导出',
  );

  // Existing metadata and physical legacy files are not moved or rewritten on upgrade.
  const legacyId = randomUUID(),
    legacyDir = join(first.directory, 'runs/old/versions/old');
  await mkdir(legacyDir, { recursive: true });
  db.prepare('INSERT INTO output_versions VALUES (?,?,?,?,?,?,?)').run(
    legacyId,
    sessionId,
    first.runId,
    legacyDir,
    'open',
    null,
    new Date().toISOString(),
  );
  await writeFile(join(legacyDir, 'report.md'), '# Legacy');
  await artifacts.publish(legacyId);
  const third = await version();
  await artifacts.publish(third.id);
  const restored = new ArtifactService(
    db,
    sessions,
    () => false,
    () => {},
  );
  const legacyFile = restored.list(sessionId).files.find((file) => file.versionId === legacyId)!;
  expect((await restored.preview(sessionId, legacyFile.id)).text).toBe('# Legacy');
  expect(
    restored.list(sessionId).files.filter((file) => file.path === legacyFile.path),
  ).toHaveLength(1);
  context.published = restored.legacyPaths(sessionId);
  expect(
    (await policy.inspect(context, { name: 'write', path: legacyFile.path, content: 'overwrite' }))
      .decision,
  ).toBe('deny');
  expect((await restored.openWorkspace(sessionId, third.runId)).directory).toBe(first.directory);
  await restored.publish(third.id);
});

it('artifacts.export streams large artifacts in bounded chunks, preserves exports and cleans failed staging', async () => {
  const { createHash } = await import('node:crypto');
  const { readVerified } = await import('../../../src/main/services/artifacts-io');
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
  expect(await artifacts.exportLocation(sessionId, exported)).toBe(exported);
  await expect(artifacts.exportLocation(sessionId, root)).rejects.toThrow('不属于当前会话');
  await expect(artifacts.exportLocation(sessions.create().id, exported)).rejects.toThrow(
    '不属于当前会话',
  );
  expect((await stat(join(exported, 'large.bin'))).size).toBe(total);
  const repeatExport = await artifacts.exportVersion(sessionId, v.id, root);
  expect(repeatExport).not.toBe(exported);
  const broken = await version();
  await writeFile(join(broken.directory, 'report.md'), 'before');
  await artifacts.publish(broken.id);
  await writeFile(join(broken.directory, 'report.md'), 'changed');
  await expect(artifacts.exportVersion(sessionId, broken.id, root)).rejects.toThrow('变更');
  const { readdir } = await import('node:fs/promises');
  expect(
    (await readdir(root)).filter((name) => name.startsWith(`Data-Agent-${broken.id}-`)),
  ).toHaveLength(2);
  expect((await stat(join(exported, 'large.bin'))).size).toBe(total);
});
