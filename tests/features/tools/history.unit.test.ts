import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createModelRuntime } from '../../../src/agent/models';
import { createWorkbenchSession } from '../../../src/agent/workbench-session';
import { configurationResources } from '../../../src/agent/agent-configuration';
import { SessionRuntime } from '../../../src/agent/session-runtime';
import { genericTools } from '../../../src/agent/tools';
import { restoreToolDeclarations } from '../../../src/agent/tools/history';
import version1 from '../../../src/agent/tools/declarations-v1.json';
import { defaultAgentConfig, type AgentBinding } from '../../../src/shared/agent-config';
import { configDigest } from '../../../src/node/agent-config-resources';
import type { RuntimeSnapshot } from '../../../src/shared/runtime';

afterEach(() => vi.unstubAllGlobals());

it('continues an exact v1 tool declaration without replacing the provider prefix', async () => {
  const root = mkdtempSync(join(tmpdir(), 'tool-history-'));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  mkdirSync(join(root, 'sessions'));
  const file = join(root, 'sessions/session.jsonl');
  const contents = {
    config: { ...defaultAgentConfig, enabledTools: ['read'] as const, enabledSkills: [] },
    skills: [],
    promptVersion: 1 as const,
  };
  const binding: AgentBinding = {
    ...contents,
    config: { ...contents.config, enabledTools: ['read'] },
    revision: 1,
    fingerprint: configDigest(contents),
    createdAt: new Date().toISOString(),
  };
  const requests: { messages: unknown[]; tools?: unknown }[] = [];
  vi.stubGlobal('fetch', async (_input: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    const chunk = (delta: unknown, finish_reason: string | null) =>
      `data: ${JSON.stringify({ id: 'history', object: 'chat.completion.chunk', created: 1, model: 'deepseek-flash', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    return new Response(
      chunk({ role: 'assistant', content: 'Done' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  });
  const executor = {
    execute: async () => ({ output: 'fixture', isError: false }),
    subscribe: () => () => {},
  };
  const tools = restoreToolDeclarations(
    genericTools(executor, (value) => value).filter((t) => t.name === 'read'),
    version1,
  );
  const manager = SessionManager.open(file, join(root, 'sessions'), workspace);
  const modelRuntime = await createModelRuntime();
  await modelRuntime.setRuntimeApiKey('deepseek', 'synthetic');
  const old = await createWorkbenchSession({
    cwd: workspace,
    agentDir: root,
    sessionManager: manager,
    modelRuntime,
    model: modelRuntime.getModel('deepseek', 'deepseek-flash'),
    thinkingLevel: 'high',
    settingsManager: SettingsManager.inMemory({ cacheWarming: 'off' }),
    resources: { systemPrompt: configurationResources(binding, workspace).prompt, skills: [] },
    registeredTools: tools,
  });
  let resumed: SessionRuntime | undefined;
  try {
    await old.session.prompt('Historical question.');
    old.session.dispose();
    const piSessionId = JSON.parse(readFileSync(file, 'utf8').split('\n')[0]).id;
    let snapshot: RuntimeSnapshot | undefined;
    resumed = await SessionRuntime.create(
      {
        sessionId: randomUUID(),
        runId: randomUUID(),
        file,
        workspace,
        piSessionId,
        model: { provider: 'deepseek', model: 'deepseek-flash' },
        apiKey: 'synthetic',
        protectedRoots: [],
        agentConfig: binding,
      },
      (value) => {
        snapshot = value;
      },
      { tools: executor },
    );
    await resumed.submit({ kind: 'prompt', inputId: randomUUID(), text: 'Continue.' });
    await vi.waitFor(() => expect(snapshot?.state).toBe('completed'));
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.slice(0, requests[0].messages.length)).toEqual(
      requests[0].messages,
    );
    expect(requests[1].tools).toEqual(requests[0].tools);
    const changed = version1.map((tool) =>
      tool.name === 'read' ? { ...tool, description: 'unrecognized declaration' } : tool,
    );
    const rejected = restoreToolDeclarations(
      genericTools(executor, (value) => value),
      changed,
    );
    expect(rejected[0].description).not.toBe('unrecognized declaration');
  } finally {
    old.session.dispose();
    await resumed?.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
