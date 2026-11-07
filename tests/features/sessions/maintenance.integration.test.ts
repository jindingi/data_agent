import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { getAppPaths, ensureAppPaths, type AppPaths } from '../../../src/node/app-paths';
import { openDatabase } from '../../../src/main/storage/database';
import { SessionService } from '../../../src/main/services/sessions';
import { ArtifactService } from '../../../src/main/services/artifacts';
import { DeletionService } from '../../../src/main/services/deletion';
import { LogService } from '../../../src/main/services/logs';

let root: string,
  paths: AppPaths,
  db: ReturnType<typeof openDatabase>,
  sessions: SessionService,
  artifacts: ArtifactService;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'data-agent-maintenance-'));
  await mkdir(join(root, 'real'));
  await symlink(join(root, 'real'), join(root, 'alias'));
  paths = getAppPaths(
    { DATA_AGENT_HOME: join(root, 'alias', 'data'), DATA_AGENT_USER_DATA: join(root, 'user') },
    true,
  );
  ensureAppPaths(paths);
  db = openDatabase(paths.database);
  sessions = new SessionService(db, paths);
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

function run(id: string) {
  const runId = randomUUID();
  db.prepare('INSERT INTO runs VALUES (?,?,?,?,?,?,?,NULL)').run(
    runId,
    id,
    randomUUID(),
    'completed',
    'fixture',
    'fixture',
    new Date().toISOString(),
  );
  return runId;
}

it('sessions.deletion-storage retains deletion inventory across restart, rejects changed files and links, preserves originals and manual files', async () => {
  const external = join(root, 'chosen-parent');
  await mkdir(external);
  const session = sessions.create(external),
    runId = run(session.id);
  const version = await artifacts.openWorkspace(session.id, runId);
  const report = join(version.directory, 'report.md'),
    original = join(version.directory, 'source.csv');
  await writeFile(report, '# report');
  await writeFile(original, 'a\n1\n');
  sessions.addFiles(session.id, [original]);
  await writeFile(session.sessionFile, 'native-history-fixture');
  await artifacts.publish(version.id);
  const manual = join(version.directory, 'manual.txt');
  await writeFile(manual, 'unregistered');
  const log = join(paths.logs, runId, 'log.txt');
  await mkdir(join(paths.logs, runId));
  await writeFile(log, 'stdout');
  new LogService(db, paths.logs).register({ runId, toolCallId: 'call', path: log });
  await writeFile(report, '# modified outside the app');
  let stops = 0,
    forgotten = 0;
  const runtime = {
    stopForDeletion: async () => {
      stops++;
      expect(await readFile(session.sessionFile, 'utf8')).toBe('native-history-fixture');
    },
    forget: () => {
      forgotten++;
    },
  };
  let deletion = new DeletionService(db, sessions, runtime, artifacts, paths, () => {});
  const first = await deletion.remove(session.id, true);
  expect(first.complete).toBe(false);
  expect(first.remaining).toHaveLength(1);
  expect(first.remaining[0].path).toBe(report);
  expect(first.remaining[0].error).toContain('已变更');
  expect(stops).toBe(1);
  expect(forgotten).toBe(0);
  await expect(readFile(session.sessionFile)).rejects.toThrow();
  await expect(readFile(log)).rejects.toThrow();
  expect(await readFile(original, 'utf8')).toBe('a\n1\n');
  expect(await readFile(manual, 'utf8')).toBe('unregistered');
  db.close();
  db = openDatabase(paths.database);
  sessions = new SessionService(db, paths);
  sessions.reconcile();
  artifacts = new ArtifactService(
    db,
    sessions,
    () => false,
    () => {},
  );
  expect(sessions.get(session.id).state).toBe('deleting');
  expect(() => sessions.addFiles(session.id, [])).toThrow('正在删除');
  deletion = new DeletionService(
    db,
    sessions,
    {
      stopForDeletion: async () => {},
      forget: () => {
        forgotten++;
      },
    },
    artifacts,
    paths,
    () => {},
  );
  expect(deletion.preview(session.id).deleteArtifacts).toBe(true);
  expect(deletion.preview(session.id).remaining[0].path).toBe(report);
  const outside = join(external, 'preserve.md');
  await writeFile(outside, '# report');
  await unlink(report);
  await symlink(outside, report);
  const redirected = await deletion.remove(session.id, false);
  expect(redirected.complete).toBe(false);
  expect(await readFile(outside, 'utf8')).toBe('# report');
  await unlink(report);
  await writeFile(report, '# report');
  expect(await deletion.remove(session.id, false)).toEqual({ complete: true, remaining: [] }); // The original explicit choice is durable.
  expect(forgotten).toBe(1);
  expect(() => sessions.get(session.id)).toThrow('会话不存在');
  expect(await readFile(original, 'utf8')).toBe('a\n1\n');
  expect(await readFile(manual, 'utf8')).toBe('unregistered');
  expect(db.prepare('SELECT * FROM deletion_files').all()).toEqual([]);
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  const keep = sessions.create(external),
    second = await artifacts.openWorkspace(keep.id, run(keep.id));
  await writeFile(join(second.directory, 'keep.md'), '# retained');
  await artifacts.publish(second.id);
  expect((await deletion.remove(keep.id, false)).complete).toBe(true);
  expect(await readFile(join(second.directory, 'keep.md'), 'utf8')).toBe('# retained');
});
