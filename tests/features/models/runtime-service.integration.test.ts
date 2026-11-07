import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { openDatabase } from '../../../src/main/storage/database';
import { SessionService } from '../../../src/main/services/sessions';
import { CredentialService } from '../../../src/main/services/credentials';
import { ToolService } from '../../../src/main/services/tools';
import { ArtifactService } from '../../../src/main/services/artifacts';
import { InteractionBroker } from '../../../src/main/services/interactions';
import { getRuntimePaths } from '../../../src/node/runtime-paths';
import { RuntimeService } from '../../../src/main/services/runtime';
import { ensureAppPaths, getAppPaths } from '../../../src/node/app-paths';
import type { RuntimeSnapshot } from '../../../src/shared/runtime';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
it('models.preflight credentials and model errors leave no run or permit; later input starts and cancellation releases admission', async () => {
  const root = mkdtempSync(join(tmpdir(), 'data-agent-admission-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const paths = getAppPaths(
    { DATA_AGENT_HOME: join(root, 'data'), DATA_AGENT_USER_DATA: join(root, 'user') },
    true,
  );
  ensureAppPaths(paths);
  const db = openDatabase(paths.database);
  cleanups.push(() => {
    db.close();
  });
  const sessions = new SessionService(db, paths);
  const secret = randomBytes(32);
  const credentials = new CredentialService(db, {
    isEncryptionAvailable: () => true,
    encryptString: (value) => {
      const nonce = randomBytes(12),
        cipher = createCipheriv('aes-256-gcm', secret, nonce);
      const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
    },
    decryptString: (value) => {
      const cipher = createDecipheriv('aes-256-gcm', secret, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([cipher.update(value.subarray(28)), cipher.final()]).toString();
    },
  });
  credentials.setCatalog([
    {
      provider: 'deepseek',
      model: 'deepseek-flash',
      name: 'DeepSeek',
      reasoning: true,
      vision: false,
      verified: false,
      thinkingLevels: ['off', 'high'],
    },
  ]);
  const events: RuntimeSnapshot[] = [];
  const usedKeys: string[] = [];
  let starts = 0,
    stops = 0;
  const service = new RuntimeService({
    db: db,
    sessions: sessions,
    credentials: credentials,
    paths: paths,
    createHost: (_status, emit) => {
      let current: RuntimeSnapshot;
      return {
        stop: () => {
          stops++;
        },
        request: async (input) => {
          if (input.type === 'runtime.start') {
            starts++;
            usedKeys.push(input.config.apiKey);
            const { sessionId, runId, hostEpoch } = input.config;
            current = {
              schemaVersion: 1,
              sessionId,
              runId,
              hostEpoch,
              seq: 1,
              state: 'running',
              messages: [],
              tools: [],
              inputs: [{ inputId: input.input.inputId, kind: 'prompt', state: 'pending' }],
              error: null,
            };
            emit(current);
          }
          if (input.type === 'runtime.cancel')
            emit({
              ...current,
              seq: 2,
              state: 'cancelled',
              inputs: current.inputs.map((item) => ({ ...item, state: 'cancelled' })),
            });
          return {};
        },
      };
    },
    reader: { readHistory: async () => ({ messages: [] }) },
    publish: (event) => events.push(event),
    changed: () => {},
    tools: new ToolService(
      getRuntimePaths(process.cwd(), '', false),
      paths.logs,
      new InteractionBroker(db),
    ),
    artifacts: new ArtifactService(
      db,
      sessions,
      () => false,
      () => {},
    ),
  });
  cleanups.push(() => service.stop());
  const session = sessions.create();
  const makeInput = () => ({
    inputId: randomUUID(),
    kind: 'prompt' as const,
    text: 'test admission',
  });
  await expect(service.submit(session.id, makeInput())).rejects.toThrow('API key');
  expect(service.snapshot(session.id)).toBeNull();
  expect(starts).toBe(0);
  expect(() => credentials.select({ provider: 'deepseek', model: 'wrong-name' })).toThrow('模型');
  expect(db.prepare('SELECT count(*) n FROM runs').get()).toEqual({ n: 0 });
  const sentinel = 'sk-synthetic-credential-do-not-persist';
  credentials.save('deepseek', sentinel);
  expect(credentials.key('deepseek')).toBe(sentinel);
  expect(JSON.stringify(credentials.settings())).not.toContain(sentinel);
  expect(JSON.stringify(db.prepare('SELECT * FROM app_metadata').all())).not.toContain(sentinel);
  await service.submit(session.id, makeInput());
  await vi.waitFor(() => expect(starts).toBe(1));
  const b = sessions.create(),
    c = sessions.create();
  await service.submit(b.id, makeInput());
  await service.submit(c.id, makeInput());
  await vi.waitFor(() => expect(starts).toBe(2));
  expect(service.snapshot(c.id)?.state).toBe('queued');
  credentials.save('deepseek', 'sk-rotated-after-queue');
  await service.cancel(session.id);
  expect(service.snapshot(session.id)?.state).toBe('cancelled');
  await vi.waitFor(() => expect(starts).toBe(3));
  expect(service.snapshot(c.id)?.state).toBe('running');
  expect(usedKeys).toEqual([sentinel, sentinel, sentinel]);
  await service.cancel(b.id);
  await service.cancel(c.id);
  expect(stops).toBe(3);
  expect(JSON.stringify(events)).not.toContain(sentinel);
  credentials.save('deepseek', '');
  expect(credentials.settings().configuredProviders).toEqual([]);
});
