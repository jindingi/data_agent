import { loadBundledSkills } from '../../../src/node/bundled-skills';
import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionRuntime, type RuntimeConfig } from '../../../src/agent/session-runtime';
import {
  defaultAgentConfig,
  normalizeAgentConfig,
  composeAgentPrompt,
  type AgentBinding,
} from '../../../src/shared/agent-config';
import { configDigest } from '../../../src/node/agent-config-resources';
import type { RuntimeSnapshot } from '../../../src/shared/runtime';
import { systemPrompt } from '../../../src/agent/runtime-context';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { bindAgentConfiguration } from '../../../src/agent/agent-configuration';
import { previewAgentPrompt } from '../../../src/agent/prompt-preview';
import { genericTools } from '../../../src/agent/tools';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllGlobals();
});
function binding(config = defaultAgentConfig): AgentBinding {
  const content = readFileSync('resources/skills/data-analysis/SKILL.md', 'utf8');
  const skills: AgentBinding['skills'] = config.enabledSkills.length
    ? [
        {
          id: 'data-analysis',
          name: 'data-analysis',
          description: content.match(/^description: (.*)$/m)![1],
          content,
          sha256: configDigest(content),
          filePath: resolve('resources/skills/data-analysis/SKILL.md'),
        },
      ]
    : [];
  const interactive = config.enabledSkills.includes('interactive-report');
  const selected = interactive
    ? loadBundledSkills(
        resolve('test-results/request-resources'),
        resolve('resources/skills'),
        resolve('runtime/report-runtime'),
      ).skills.filter((s) => config.enabledSkills.includes(s.id))
    : skills;
  const contents = {
    config: normalizeAgentConfig(config),
    skills: selected,
    promptVersion: interactive ? (2 as const) : (1 as const),
  };
  return {
    ...contents,
    revision: 1,
    fingerprint: configDigest(contents),
    createdAt: new Date().toISOString(),
  };
}
it('keeps the default prompt compatible, rejects conflicting skills and normalizes tool order', () => {
  expect(composeAgentPrompt('/workspace', defaultAgentConfig)).toBe(
    systemPrompt('/workspace', true),
  );
  expect(() => normalizeAgentConfig({ ...defaultAgentConfig, enabledTools: [] })).toThrow('read');
  expect(
    normalizeAgentConfig({ ...defaultAgentConfig, enabledTools: ['bash', 'read'] }).enabledTools,
  ).toEqual(['read', 'bash']);
});
it('refuses to silently remove an unknown historical system section', () => {
  const agentConfig = binding({ ...defaultAgentConfig, enabledTools: [], enabledSkills: [] });
  const manager = SessionManager.inMemory('/workspace');
  manager.appendMessage({
    role: 'system',
    content: '',
    sections: {
      preamble: composeAgentPrompt('/workspace', agentConfig.config),
      cwd: '<cwd>\n/workspace\n</cwd>',
      addendum: '<addendum>\nHistorical instructions\n</addendum>',
    },
    timestamp: Date.now(),
  });
  const before = manager.getEntries();
  expect(() => bindAgentConfiguration(manager, agentConfig, '/workspace', [])).toThrow(
    '配置待确认',
  );
  expect(manager.getEntries()).toEqual(before);
});
it.each(['description', 'parameters', 'order'] as const)(
  'rejects incompatible historical tool %s without changing history',
  (changed) => {
    const agentConfig = binding({
      ...defaultAgentConfig,
      enabledTools: ['read', 'write'],
      enabledSkills: [],
    });
    const tools = genericTools(
      {
        execute: vi.fn(),
        subscribe: () => () => {},
      },
      (value) => value,
    ).filter((tool) => tool.name === 'read' || tool.name === 'write');
    const declarations = tools.map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
    if (changed === 'description') declarations[0].description = 'Historical description';
    if (changed === 'parameters')
      declarations[0].parameters = {
        type: 'object',
        properties: { path: { type: 'number' } },
        required: ['path'],
      };
    if (changed === 'order') declarations.reverse();
    const manager = SessionManager.inMemory('/workspace');
    manager.appendMessage({
      role: 'system',
      content: '',
      sections: {
        preamble: composeAgentPrompt('/workspace', agentConfig.config),
        cwd: '<cwd>\n/workspace\n</cwd>',
      },
      toolsAdded: declarations,
      timestamp: Date.now(),
    });
    const before = structuredClone(manager.getEntries());
    expect(() => bindAgentConfiguration(manager, agentConfig, '/workspace', tools)).toThrow(
      '工具声明与运行时不兼容',
    );
    expect(manager.getEntries()).toEqual(before);
  },
);
it.each([true, false, 'interactive', 'both'] as const)(
  'preserves provider prefixes across tools, steering, follow-up and restart (skills=%s)',
  async (withSkill) => {
    const root = mkdtempSync(join(tmpdir(), 'agent-config-wire-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'workspace'));
    mkdirSync(join(root, 'sessions'));
    const agentConfig = binding({
      ...defaultAgentConfig,
      systemPrompt: 'Synthetic custom instructions.',
      enabledTools: ['read'],
      enabledSkills:
        withSkill === 'interactive'
          ? ['interactive-report']
          : withSkill === 'both'
            ? ['data-analysis', 'interactive-report']
            : withSkill
              ? ['data-analysis']
              : [],
    });
    const config: RuntimeConfig = {
      sessionId: randomUUID(),
      runId: randomUUID(),
      workspace: join(root, 'workspace'),
      file: join(root, 'sessions/session.jsonl'),
      piSessionId: null,
      model: { provider: 'deepseek', model: 'deepseek-flash' },
      apiKey: 'synthetic',
      protectedRoots: [],
      agentConfig,
    };
    const payloads: { messages: unknown[]; tools?: { function: { name: string } }[] }[] = [];
    let calls = 0,
      snapshot: RuntimeSnapshot | undefined,
      toolStarted = false;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal('fetch', async () => {
      const tool = calls++ === 0;
      const delta = tool
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'fixture-read',
                type: 'function',
                function: { name: 'read', arguments: JSON.stringify({ path: 'input.txt' }) },
              },
            ],
          }
        : { role: 'assistant', content: 'Done' };
      const chunk = (delta: unknown, finish_reason: string | null) =>
        `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'deepseek-flash', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
      return new Response(
        chunk(delta, null) + chunk({}, tool ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    });
    const dependencies = {
      tools: {
        execute: async () => {
          toolStarted = true;
          await pending;
          return { output: 'synthetic data', isError: false };
        },
        subscribe: () => () => {},
      },
      onRequest: (payload: unknown) =>
        payloads.push(structuredClone(payload) as (typeof payloads)[number]),
    };
    let runtime = await SessionRuntime.create(
      config,
      (value) => {
        snapshot = value;
      },
      dependencies,
    );
    cleanups.push(() => runtime.dispose());
    await runtime.submit({ inputId: randomUUID(), kind: 'prompt', text: 'Read input.txt.' });
    await vi.waitFor(() => expect(toolStarted).toBe(true));
    await runtime.submit({ inputId: randomUUID(), kind: 'steer', text: 'Keep it short.' });
    await runtime.submit({ inputId: randomUUID(), kind: 'followUp', text: 'Then summarize.' });
    release();
    await vi.waitFor(() => expect(snapshot?.state).toBe('completed'), { timeout: 8000 });
    expect(payloads.length).toBeGreaterThanOrEqual(3);
    const firstSystem = JSON.stringify(payloads[0].messages[0]);
    const preview = await previewAgentPrompt(agentConfig, config.workspace);
    expect(preview.source).toBe('assembled');
    expect(preview.text).toBe((payloads[0].messages[0] as { content: string }).content);
    expect(preview.text).toContain('<cwd>');
    expect(preview.text.includes('<skills>')).toBe(Boolean(withSkill));
    expect(firstSystem).toContain('Synthetic custom instructions.');
    expect(firstSystem.includes('<available_skills>')).toBe(Boolean(withSkill));
    if (!withSkill) expect(firstSystem).not.toContain('data-analysis');
    expect(payloads[0].tools?.map((tool) => tool.function.name)).toEqual(['read']);
    const records = readFileSync(config.file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(records.filter((e) => e.customType === 'data_agent.agent_config')).toHaveLength(1);
    const beforePreview = readFileSync(config.file, 'utf8');
    const historyPreview = await previewAgentPrompt(agentConfig, config.workspace, {
      file: config.file,
      piSessionId: records[0].id,
    });
    expect(historyPreview).toEqual({ text: preview.text, source: 'history' });
    expect(readFileSync(config.file, 'utf8')).toBe(beforePreview);
    await runtime.dispose();
    snapshot = undefined;
    runtime = await SessionRuntime.create(
      { ...config, piSessionId: records[0].id, runId: randomUUID() },
      (value) => {
        snapshot = value;
      },
      dependencies,
    );
    await runtime.submit({
      inputId: randomUUID(),
      kind: 'prompt',
      text: 'Continue.',
      paths: [join(root, 'new.csv')],
    });
    await vi.waitFor(() => expect(snapshot?.state).toBe('completed'), { timeout: 8000 });
    for (let i = 1; i < payloads.length; i++) {
      expect(payloads[i].messages.slice(0, payloads[i - 1].messages.length)).toEqual(
        payloads[i - 1].messages,
      );
      expect(payloads[i].tools).toEqual(payloads[0].tools);
    }
    expect(JSON.stringify(payloads.at(-1)!.messages.at(-1))).toContain('new.csv');
    await runtime.dispose();
    await expect(
      SessionRuntime.create(
        { ...config, agentConfig: binding({ ...defaultAgentConfig, systemPrompt: 'wrong' }) },
        () => {},
        dependencies,
      ),
    ).rejects.toThrow('不一致');
  },
);
it('registers no fallback tools when all tools and skills are disabled', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-config-chat-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'workspace'));
  mkdirSync(join(root, 'sessions'));
  let payload: { tools?: unknown[]; messages: { content: string }[] } | undefined,
    snapshot: RuntimeSnapshot | undefined;
  vi.stubGlobal(
    'fetch',
    async () =>
      new Response(
        `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'deepseek-flash', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } },
      ),
  );
  const execute = vi.fn();
  const agentConfig = binding({ ...defaultAgentConfig, enabledTools: [], enabledSkills: [] });
  const runtime = await SessionRuntime.create(
    {
      sessionId: randomUUID(),
      runId: randomUUID(),
      workspace: join(root, 'workspace'),
      file: join(root, 'sessions/s.jsonl'),
      piSessionId: null,
      model: { provider: 'deepseek', model: 'deepseek-flash' },
      apiKey: 'synthetic',
      protectedRoots: [],
      agentConfig,
    },
    (value) => {
      snapshot = value;
    },
    {
      tools: { execute, subscribe: () => () => {} },
      onRequest: (value) => {
        payload = value as typeof payload;
      },
    },
  );
  cleanups.push(() => runtime.dispose());
  await runtime.submit({ inputId: randomUUID(), kind: 'prompt', text: 'Hello' });
  await vi.waitFor(() => expect(snapshot?.state).toBe('completed'), { timeout: 8000 });
  expect(payload?.tools ?? []).toHaveLength(0);
  expect(execute).not.toHaveBeenCalled();
  expect(JSON.stringify(payload)).not.toContain('available_skills');
  const preview = await previewAgentPrompt(agentConfig, join(root, 'workspace'));
  expect(preview.text).toBe(payload!.messages[0].content);
});
