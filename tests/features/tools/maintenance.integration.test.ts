import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getAppPaths, ensureAppPaths, type AppPaths } from '../../../src/node/app-paths';
import { openDatabase } from '../../../src/main/storage/database';
import { SessionService } from '../../../src/main/services/sessions';
import { readText } from '../../../src/node/read-text';

let root: string, paths: AppPaths, db: ReturnType<typeof openDatabase>, sessions: SessionService;

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
});

afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});

it('tools.read-encoding returns explicit tool errors for binary and invalid UTF-8 while allowing ordinary text', async () => {
  const session = sessions.create();
  for (const [name, bytes] of [
    ['image.png', Buffer.from([137, 80, 78, 71, 0])],
    ['legacy.csv', Buffer.from([0xd6, 0xd0, 0xce, 0xc4])],
    ['partial.csv', Buffer.from([0x61, 0xe4, 0xb8])],
  ] as const) {
    await writeFile(join(session.workspace, name), bytes);
    await expect(readText(session.workspace, [], { path: name })).rejects.toThrow(/文本|UTF-8/);
  }
  await writeFile(join(session.workspace, 'plain.csv'), '\ufeff名字,金额\n甲,2\n');
  expect((await readText(session.workspace, [], { path: 'plain.csv' })).output).toContain(
    '名字,金额',
  );
});
