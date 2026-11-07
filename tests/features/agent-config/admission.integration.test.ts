import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../../../src/main/storage/database';
import { AgentConfigService } from '../../../src/main/services/agent-config';
import { SessionService } from '../../../src/main/services/sessions';
import { CredentialService } from '../../../src/main/services/credentials';
import { RuntimeService } from '../../../src/main/services/runtime';
import type { ToolHandler } from '../../../src/main/services/agent-process';
import { ToolService } from '../../../src/main/services/tools';
import { InteractionBroker } from '../../../src/main/services/interactions';
import { getRuntimePaths } from '../../../src/node/runtime-paths';
import { ensureAppPaths, getAppPaths } from '../../../src/node/app-paths';
import { defaultAgentConfig } from '../../../src/shared/agent-config';
import type { RuntimeSnapshot } from '../../../src/shared/runtime';
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
it('agent-config.admission queued and running sessions retain bindings; Main rejects disabled tool requests', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-config-admission-'));
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
  const configs = new AgentConfigService(db, paths, resolve('resources/skills'));
  configs.save({ ...defaultAgentConfig, enabledTools: ['read'], enabledSkills: [] }, 1);
  const sessions = new SessionService(db, paths, undefined, configs);
  const credentials = new CredentialService(db, {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value),
    decryptString: (value) => value.toString(),
  });
  credentials.setCatalog([
    {
      provider: 'deepseek',
      model: 'deepseek-flash',
      name: 'Synthetic',
      reasoning: true,
      vision: false,
      verified: false,
      thinkingLevels: ['off', 'high'],
    },
  ]);
  credentials.save('deepseek', 'synthetic');
  await credentials.discover(
    'deepseek',
    undefined,
    async () => new Response(JSON.stringify({ data: [{ id: 'deepseek-flash' }] })),
  );
  const tools = new ToolService(
    getRuntimePaths(process.cwd(), '', false),
    paths.logs,
    new InteractionBroker(),
  );
  const execute = vi
    .spyOn(tools, 'execute')
    .mockResolvedValue({ output: 'synthetic read', isError: false });
  const handlers = new Map<string, ToolHandler>();
  const versions: number[] = [];
  const service = new RuntimeService({
    db,
    sessions,
    credentials,
    paths,
    agentConfigs: configs,
    tools,
    reader: { readHistory: async () => ({ messages: [] }) },
    publish: () => {},
    changed: () => {},
    createHost: (_status, emit, tool) => {
      let current: RuntimeSnapshot;
      return {
        pid: process.pid,
        stop: () => {},
        request: async (input) => {
          if (input.type === 'runtime.start') {
            versions.push(input.config.agentConfig!.revision!);
            handlers.set(input.config.sessionId, tool);
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
              inputs: current.inputs.map((i) => ({ ...i, state: 'cancelled' })),
            });
          return {};
        },
      };
    },
  });
  cleanups.push(() => service.stop());
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const accepted = await service.submitConversation({
      inputId: randomUUID(),
      kind: 'prompt',
      text: 'Synthetic task',
    });
    ids.push(accepted.sessionId);
  }
  await vi.waitFor(() => expect(versions).toEqual([2, 2]));
  expect(service.snapshot(ids[2])?.state).toBe('queued');
  configs.save({ ...defaultAgentConfig, systemPrompt: 'New default' }, 2);
  const observers = { output: () => {}, interaction: () => {} };
  const denied = await handlers.get(ids[0])!(
    'forged-write',
    { name: 'write', path: 'should-not-exist.txt', content: 'unsafe' },
    observers,
  );
  expect(denied.isError).toBe(true);
  expect(denied.output).toContain('未启用');
  expect(execute).not.toHaveBeenCalled();
  await handlers.get(ids[0])!('allowed-read', { name: 'read', path: 'input.txt' }, observers);
  expect(execute).toHaveBeenCalledOnce();
  await service.cancel(ids[0]);
  await vi.waitFor(() => expect(versions).toEqual([2, 2, 2]));
  expect(configs.require(ids[2]).revision).toBe(2);
  await service.cancel(ids[1]);
  await service.cancel(ids[2]);
  const next = await service.submitConversation({
    inputId: randomUUID(),
    kind: 'prompt',
    text: 'New default task',
  });
  await vi.waitFor(() => expect(versions).toEqual([2, 2, 2, 3]));
  expect(configs.require(next.sessionId).revision).toBe(3);
  await service.cancel(next.sessionId);
});
