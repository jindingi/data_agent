import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getAppPaths, ensureAppPaths } from '../../../src/node/app-paths';
import { openDatabase } from '../../../src/main/storage/database';
import { SessionService } from '../../../src/main/services/sessions';
import { DeletionService } from '../../../src/main/services/deletion';
it('sessions.deletion-storage recovers internal cleanup after restart without touching any workspace files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'deletion-'));
  const paths = getAppPaths(
    { DATA_AGENT_HOME: join(root, 'data'), DATA_AGENT_USER_DATA: join(root, 'user') },
    true,
  );
  ensureAppPaths(paths);
  let db = openDatabase(paths.database);
  try {
    let sessions = new SessionService(db, paths);
    const session = sessions.create();
    const files = ['report.md', 'source.csv', 'manual.txt', '.hidden'];
    for (const name of files) await writeFile(join(session.workspace, name), name);
    await writeFile(session.sessionFile, 'history');
    await mkdir(join(paths.logs, session.id));
    const outside = join(root, 'keep');
    await writeFile(outside, 'outside');
    const link = join(paths.logs, session.id, 'redirect');
    await symlink(outside, link);
    let stops = 0;
    const runtime = {
      stopForDeletion: async () => {
        stops++;
      },
      forget: () => {},
    };
    const deletion = new DeletionService(db, sessions, runtime, paths, () => {});
    expect((await deletion.remove(session.id)).complete).toBe(false);
    expect(await readFile(outside, 'utf8')).toBe('outside');
    await unlink(link);
    const interrupted = new DeletionService(db, sessions, runtime, paths, () => {}, {
      afterInternalCleanup: () => {
        throw new Error('injected crash boundary');
      },
    });
    expect((await interrupted.remove(session.id)).complete).toBe(false);
    await expect(readFile(session.sessionFile)).rejects.toThrow();
    db.close();
    db = openDatabase(paths.database);
    sessions = new SessionService(db, paths);
    expect(sessions.get(session.id).state).toBe('deleting');
    const resumed = new DeletionService(db, sessions, runtime, paths, () => {});
    expect(await resumed.remove(session.id)).toEqual({ complete: true, remaining: [] });
    expect(stops).toBe(3);
    for (const name of files)
      expect(await readFile(join(session.workspace, name), 'utf8')).toBe(name);
    expect(() => sessions.get(session.id)).toThrow();
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
