import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { getAppPaths, ensureAppPaths, type AppPaths } from '../../../src/node/app-paths';
import { openDatabase } from '../../../src/main/storage/database';
import { SessionService } from '../../../src/main/services/sessions';
import { ArtifactService } from '../../../src/main/services/artifacts';
import { LogService } from '../../../src/main/services/logs';
import { readText } from '../../../src/node/read-text';

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

it('tools.log-storage paginates UTF-8 without loss, enforces session scope, and rejects redirected paths', async () => {
  const session = sessions.create(),
    other = sessions.create(),
    runId = run(session.id),
    logs = new LogService(db, paths.logs);
  const path = join(paths.logs, runId, 'tool.log');
  await mkdir(join(paths.logs, runId));
  const content = 'a'.repeat(32767) + '中文\n'.repeat(18000) + 'END_MARKER';
  await writeFile(path, content);
  logs.register({ runId, toolCallId: 'tool', path });
  logs.register({
    runId,
    toolCallId: 'tool',
    path,
    result: { output: '', reason: 'exit', peakRss: 123, exitCode: 0, truncated: true, pid: 1 },
  });
  const rows = logs.list(session.id, 'tool');
  expect(rows).toHaveLength(1);
  expect(rows[0].peakRss).toBe(123);
  expect(rows[0].truncated).toBe(true);
  expect(logs.list(other.id, 'tool')).toEqual([]);
  await expect(logs.page(other.id, rows[0].id, 0)).rejects.toThrow('不属于当前会话');
  let offset = 0,
    output = '',
    pages = 0;
  while (true) {
    const page = await logs.page(session.id, rows[0].id, offset);
    output += page.text;
    pages++;
    if (page.nextOffset === null) break;
    expect(page.nextOffset).toBeGreaterThan(offset);
    offset = page.nextOffset;
  }
  expect(pages).toBeGreaterThan(3);
  expect(output).toBe(content);
  await unlink(path);
  const secret = join(root, 'secret');
  await writeFile(secret, 'must not expose');
  await symlink(secret, path);
  await expect(logs.page(session.id, rows[0].id, 0)).rejects.toThrow('已变更');
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
