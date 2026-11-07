import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { submissionDigest } from '../../../src/node/submission-digest';
import {
  SessionManager,
  createAgentSession,
  ModelRuntime,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import { registerFauxProvider, streamSimple } from '@earendil-works/pi-ai/compat';
import { createResourceLoader } from '../../../src/agent/resource-loader';
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux';
import { openDatabase, migrate, migrations } from '../../../src/main/storage/database';
import { SessionService } from '../../../src/main/services/sessions';
import { ensureAppPaths, getAppPaths } from '../../../src/node/app-paths';
import { readHistory } from '../../../src/agent/history';

let root: string;
let db: ReturnType<typeof openDatabase>;
let sessions: SessionService;
let paths: ReturnType<typeof getAppPaths>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'data-agent-storage-'));
  paths = getAppPaths(
    { DATA_AGENT_HOME: join(root, 'data'), DATA_AGENT_USER_DATA: join(root, 'userData') },
    true,
  );
  ensureAppPaths(paths);
  db = openDatabase(paths.database);
  sessions = new SessionService(db, paths);
});
afterEach(() => {
  db?.close();
  rmSync(root, { recursive: true, force: true });
});
function nativeHistory() {
  const row = sessions.create();
  const manager = SessionManager.open(row.sessionFile, paths.sessions, row.workspace);
  manager.appendMessage({ role: 'user', content: '请记住测试上下文', timestamp: Date.now() });
  manager.appendMessage(fauxAssistantMessage('SDK 已保存这段测试上下文。'));
  return { row, manager };
}

describe('native storage acceptance', () => {
  it('sessions.schema migrations are idempotent and transactional', () => {
    migrate(db);
    expect(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()).toEqual({
      n: migrations.length,
    });
    expect(() =>
      migrate(db, [
        {
          version: 999,
          sql: 'CREATE TABLE rollback_probe(id TEXT); INSERT INTO table_that_does_not_exist VALUES (1);',
        },
      ]),
    ).toThrow();
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='rollback_probe'").get(),
    ).toBeUndefined();
    expect(
      db.prepare('SELECT version FROM schema_migrations WHERE version=999').get(),
    ).toBeUndefined();
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    // Upgrade an actual v8 receipt without retaining a second permanent message copy.
    const legacy = new Database(':memory:');
    try {
      migrate(
        legacy,
        migrations.filter((migration) => migration.version <= 8),
      );
      const input = {
        inputId: randomUUID(),
        kind: 'prompt' as const,
        text: 'private receipt body',
        paths: ['/tmp/input.csv'],
      };
      const legacySession = new SessionService(legacy, paths).create();
      const runId = randomUUID();
      legacy
        .prepare('INSERT INTO runs VALUES (?,?,?,?,?,?,?,NULL)')
        .run(
          runId,
          legacySession.id,
          randomUUID(),
          'completed',
          'test',
          'test',
          new Date().toISOString(),
        );
      legacy
        .prepare('INSERT INTO run_inputs VALUES (?,?,?,?,NULL)')
        .run(input.inputId, runId, 'prompt', 'committed');
      legacy
        .prepare('INSERT INTO submission_receipts VALUES (?,?,?)')
        .run(input.inputId, legacySession.id, JSON.stringify(input));
      migrate(legacy);
      migrate(legacy);
      const receipt = legacy
        .prepare('SELECT input_id,session_id,digest FROM input_submissions')
        .get();
      expect(receipt).toEqual({
        input_id: input.inputId,
        session_id: legacySession.id,
        digest: submissionDigest(input),
      });
      expect(JSON.stringify(receipt)).not.toContain(input.text);
    } finally {
      legacy.close();
    }
  });
  it('sessions.native-history-roundtrip native JSONL round-trips through the production history reader', async () => {
    const { row, manager } = nativeHistory();
    sessions.reconcile(row.id);
    expect(sessions.get(row.id).piSessionId).toBe(manager.getSessionId());
    expect(row.sessionFile).toBe(join(paths.sessions, `${row.id}.jsonl`));
    const history = readHistory(row.sessionFile, row.workspace, manager.getSessionId());
    expect(history.items.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(history.items[0].text).toBe('请记住测试上下文');
    const records = readFileSync(row.sessionFile, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records[0].type).toBe('session');
    expect(records[1].parentId).toBeNull();
    expect(records[2].parentId).toBe(records[1].id);
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%message%'")
        .all(),
    ).toEqual([]);
    mkdirSync(join(row.workspace, '.pi/extensions'), { recursive: true });
    writeFileSync(
      join(row.workspace, '.pi/extensions/untrusted.ts'),
      'throw new Error("UNTRUSTED_EXTENSION_EXECUTED");',
    );
    writeFileSync(join(row.workspace, 'AGENTS.md'), 'UNTRUSTED_CONTEXT_FILE');
    const loader = createResourceLoader({ systemPrompt: 'Trusted workbench instructions.' });
    await loader.reload();
    expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
    expect(loader.getSystemPrompt()).toBe('Trusted workbench instructions.');
    const faux = registerFauxProvider({ provider: 'p1-native-tree' });
    const runtime = await ModelRuntime.create({
      authPath: join(root, 'auth.json'),
      modelsPath: null,
      modelsStorePath: join(root, 'models.json'),
      allowModelNetwork: false,
    });
    runtime.registerProvider(faux.getModel().provider, {
      api: faux.api,
      apiKey: 'synthetic-test-only',
      baseUrl: faux.getModel().baseUrl,
      models: faux.models,
    });
    const { session } = await createAgentSession({
      cwd: row.workspace,
      agentDir: join(root, 'agent'),
      sessionManager: manager,
      modelRuntime: runtime,
      model: faux.getModel(),
      resourceLoader: loader,
      tools: ['read'],
      settingsManager: SettingsManager.inMemory({
        retry: { enabled: false },
        compaction: { enabled: false },
        cacheWarming: 'off',
      }),
    });
    session.agent.streamFunction = streamSimple;
    try {
      faux.setResponses([fauxAssistantMessage('Native conversation continued.')]);
      await session.prompt('继续测试会话');
      const continued = readHistory(row.sessionFile, row.workspace, manager.getSessionId());
      expect(continued.items[0].id).toBe(history.items[0].id);
      expect(continued.items.filter((item) => item.text === '继续测试会话')).toHaveLength(1);
      expect(
        continued.items.filter((item) => item.text === 'Native conversation continued.'),
      ).toHaveLength(1);
      expect(session.agent.state.systemPrompt).toContain('Trusted workbench instructions.');
      expect(session.agent.state.systemPrompt).not.toContain('UNTRUSTED_CONTEXT_FILE');
      console.info('Native persisted roles:', continued.items.map((item) => item.role).join(', '));
    } finally {
      await session.dispose();
      faux.unregister();
    }
  });
  it('sessions.history-recovery damaged, missing and incompatible history is never silently rewritten', () => {
    const { row, manager } = nativeHistory();
    sessions.reconcile(row.id);
    const original = readFileSync(row.sessionFile, 'utf8');
    const variants = [
      '',
      original + '{bad}\n',
      original.slice(0, -3),
      original.replace('"version":3', '"version":999'),
      original.replace(manager.getSessionId(), 'different-id'),
    ];
    for (const value of variants) {
      writeFileSync(row.sessionFile, value);
      const before = createHash('sha256').update(readFileSync(row.sessionFile)).digest('hex');
      sessions.reconcile(row.id);
      expect(['corrupt', 'incompatible']).toContain(sessions.get(row.id).state);
      expect(() => readHistory(row.sessionFile, row.workspace, manager.getSessionId())).toThrow();
      expect(createHash('sha256').update(readFileSync(row.sessionFile)).digest('hex')).toBe(before);
    }
    rmSync(row.sessionFile);
    sessions.reconcile(row.id);
    expect(sessions.get(row.id).state).toBe('missing');
    expect(existsSync(row.sessionFile)).toBe(false);
    renameSync(row.workspace, `${row.workspace}.moved`);
    sessions.reconcile(row.id);
    expect(sessions.get(row.id).state).toBe('unavailable');
    expect(existsSync(row.workspace)).toBe(false);
  });
  it('sessions.coordination recovers creating intents and history committed before metadata', () => {
    const faulty = new SessionService(db, paths, {
      afterWorkspaceCreated: () => {
        throw new Error('injected metadata failure');
      },
    });
    expect(() => faulty.create()).toThrow('injected metadata failure');
    const pending = sessions.list()[0];
    expect(pending.state).toBe('creating');
    expect(existsSync(pending.workspace)).toBe(true);
    sessions.reconcile();
    expect(sessions.get(pending.id).state).toBe('draft');
    const { row, manager } = nativeHistory();
    expect(sessions.get(row.id).piSessionId).toBeNull();
    const before = readFileSync(row.sessionFile, 'utf8');
    const restarted = new SessionService(db, paths);
    restarted.reconcile();
    restarted.reconcile();
    expect(restarted.get(row.id).piSessionId).toBe(manager.getSessionId());
    expect(restarted.get(row.id).state).toBe('persisted');
    expect(readFileSync(row.sessionFile, 'utf8')).toBe(before);
    expect(readdirSync(paths.sessions)).toEqual([`${row.id}.jsonl`]);
  });
});
