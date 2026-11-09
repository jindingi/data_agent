import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionRuntime } from '../../../src/agent/session-runtime';
import { testModelConnection } from '../../../src/agent/model-connection';
import { compatibleModelSchema, type CompatibleModel } from '../../../src/shared/compatible-models';
import type { RuntimeSnapshot } from '../../../src/shared/runtime';
import { modelFixture } from '../../../scripts/test/model-fixture.mjs';

const definition: CompatibleModel = {
  model: 'private-alias',
  name: 'Private alias',
  contextWindow: 131072,
  maxTokens: 16384,
  reasoning: false,
  vision: false,
  profile: 'basic',
};

it('validates unknown model metadata and rejects unbounded or injected protocol settings', () => {
  expect(compatibleModelSchema.parse(definition)).toEqual(definition);
  for (const patch of [
    { api: 'anthropic-messages' },
    { contextWindow: 16000 },
    { maxTokens: 200000 },
    { profile: 'unknown' },
    { reasoning: true },
  ])
    expect(compatibleModelSchema.safeParse({ ...definition, ...patch }).success).toBe(false);
});

it.each(['openai-chat-compatible', 'openai-responses-compatible'])(
  'runs %s through actual HTTP, tools, appended inputs, usage and restart with stable wire prefixes',
  async (provider) => {
    const fixture = await modelFixture();
    const root = mkdtempSync(join(tmpdir(), 'data-agent-compatible-'));
    mkdirSync(join(root, 'workspace'));
    writeFileSync(join(root, 'workspace/data.txt'), 'fixture 中文 content');
    const file = join(root, 'session.jsonl');
    let runtime: SessionRuntime | undefined;
    let latest: RuntimeSnapshot | undefined;
    const bodies: Record<string, unknown>[] = [];
    const urls: string[] = [];
    const fetcher: typeof fetch = async (url, init) => {
      urls.push(String(url));
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic');
      return fetch(url, init);
    };
    const config = {
      sessionId: randomUUID(),
      runId: randomUUID(),
      file,
      workspace: join(root, 'workspace'),
      piSessionId: null as string | null,
      model: { provider, model: definition.model },
      compatibleModel: definition,
      apiKey: 'synthetic',
      baseUrl: fixture.baseUrl,
      protectedRoots: [],
    };
    try {
      fixture.set({ text: 'OK' });
      await testModelConnection(config, fetcher);
      bodies.splice(0);
      urls.splice(0);
      fixture.set(
        { tool: { name: 'read', args: { path: 'data.txt' } } },
        { text: 'Tool finished.' },
      );
      runtime = await SessionRuntime.create(
        config,
        (s) => {
          latest = s;
        },
        { fetch: fetcher },
      );
      await runtime.submit({ inputId: randomUUID(), kind: 'prompt', text: 'Read data.txt.' });
      await expect.poll(() => latest?.state).toBe('completed');
      expect(latest?.tools[0]?.status).toBe('completed');
      expect(latest?.tools[0]?.output).toContain('fixture 中文');
      expect(bodies).toHaveLength(2);
      const field = provider === 'openai-chat-compatible' ? 'messages' : 'input';
      const prefix = bodies[0][field] as unknown[];
      expect((bodies[1][field] as unknown[]).slice(0, prefix.length)).toEqual(prefix);
      expect(bodies[1].tools).toEqual(bodies[0].tools);
      expect(JSON.stringify(bodies[1])).toContain('fixture 中文');
      expect(
        urls.every((url) =>
          url.endsWith(provider === 'openai-chat-compatible' ? '/chat/completions' : '/responses'),
        ),
      ).toBe(true);
      const sessionId = JSON.parse(readFileSync(file, 'utf8').split('\n')[0]).id;
      await runtime.dispose();
      runtime = undefined;
      const old = readFileSync(file, 'utf8');
      fixture.set({ text: 'Continued.' });
      runtime = await SessionRuntime.create(
        { ...config, piSessionId: sessionId, runId: randomUUID() },
        (s) => {
          latest = s;
        },
        { fetch: fetcher },
      );
      expect(readFileSync(file, 'utf8')).toBe(old);
      await runtime.submit({
        inputId: randomUUID(),
        kind: 'prompt',
        text: 'Continue.',
        paths: [join(root, 'new.csv')],
      });
      await expect.poll(() => latest?.state).toBe('completed');
      const prior = bodies[1][field] as unknown[];
      expect((bodies[2][field] as unknown[]).slice(0, prior.length)).toEqual(prior);
      expect(JSON.stringify(bodies[2])).toContain('new.csv');
      expect(JSON.stringify(bodies)).not.toContain('执行预算');
      expect(latest?.turnUsage?.at(-1)?.calls).toBe(1);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      fixture.set(
        async () => {
          await gate;
          return { tool: { name: 'read', args: { path: 'data.txt' } } };
        },
        { text: 'Steered.' },
        { text: 'Followed.' },
      );
      await runtime.submit({
        inputId: randomUUID(),
        kind: 'prompt',
        text: 'Begin another tool loop.',
      });
      await expect.poll(() => bodies.length).toBe(4);
      await runtime.submit({
        inputId: randomUUID(),
        kind: 'steer',
        text: 'Keep the existing prefix.',
      });
      await runtime.submit({
        inputId: randomUUID(),
        kind: 'followUp',
        text: 'Append this followup.',
      });
      release();
      await expect.poll(() => latest?.state).toBe('completed');
      expect(bodies.length).toBeGreaterThanOrEqual(6);
      expect(JSON.stringify(bodies)).toContain('Keep the existing prefix.');
      expect(JSON.stringify(bodies)).toContain('Append this followup.');
      for (let i = 3; i < bodies.length; i++) {
        const previous = bodies[i - 1][field] as unknown[];
        expect((bodies[i][field] as unknown[]).slice(0, previous.length)).toEqual(previous);
        expect(bodies[i].tools).toEqual(bodies[0].tools);
      }

      await runtime.dispose();
      runtime = undefined;
      const unchanged = readFileSync(file, 'utf8');
      await expect(
        SessionRuntime.create(
          {
            ...config,
            piSessionId: sessionId,
            compatibleModel: { ...definition, profile: 'openai' },
          },
          () => {},
        ),
      ).rejects.toMatchObject({ code: 'MODEL_HISTORY_MISMATCH' });
      expect(readFileSync(file, 'utf8')).toBe(unchanged);
      await expect(
        SessionRuntime.create(
          {
            ...config,
            piSessionId: sessionId,
            model: {
              ...config.model,
              provider:
                provider === 'openai-chat-compatible'
                  ? 'openai-responses-compatible'
                  : 'openai-chat-compatible',
            },
          },
          () => {},
        ),
      ).rejects.toMatchObject({ code: 'MODEL_HISTORY_MISMATCH' });
      expect(readFileSync(file, 'utf8')).toBe(unchanged);
    } finally {
      await runtime?.dispose();
      await fixture.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  20000,
);

it.each(['openai-chat-compatible', 'openai-responses-compatible'])(
  'marks the permitted compaction prefix rebuild for %s and continues from its native summary',
  async (provider) => {
    const fixture = await modelFixture();
    const root = mkdtempSync(join(tmpdir(), 'data-agent-compatible-compact-'));
    mkdirSync(join(root, 'workspace'));
    const bodies: Record<string, unknown>[] = [];
    const file = join(root, 'session.jsonl');
    let runtime: SessionRuntime | undefined;
    let latest: RuntimeSnapshot | undefined;
    try {
      const usage =
        provider === 'openai-chat-compatible'
          ? { prompt_tokens: 120000, completion_tokens: 10, total_tokens: 120010 }
          : { input_tokens: 120000, output_tokens: 10, total_tokens: 120010 };
      fixture.set(
        {
          text:
            'PRE_COMPACTION_MARKER\n' + 'Long synthetic context for real compaction. '.repeat(3000),
          usage,
        },
        { text: '## Summary\nThe user requested a short reply. No files changed.' },
      );
      runtime = await SessionRuntime.create(
        {
          sessionId: randomUUID(),
          runId: randomUUID(),
          file,
          workspace: join(root, 'workspace'),
          piSessionId: null,
          model: { provider, model: definition.model },
          compatibleModel: definition,
          apiKey: 'synthetic',
          baseUrl: fixture.baseUrl,
          protectedRoots: [],
        },
        (s) => {
          latest = s;
        },
        {
          fetch: async (url, init) => {
            bodies.push(JSON.parse(String(init?.body)));
            return fetch(url, init);
          },
        },
      );
      await runtime.submit({ inputId: randomUUID(), kind: 'prompt', text: 'Give a short reply.' });
      await expect.poll(() => latest?.state, { timeout: 10000 }).toBe('completed');
      const entries = readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      // Compaction is the explicit allowed boundary for reconstructing the prior prefix.
      expect(entries.some((entry) => entry.type === 'compaction')).toBe(true);
      expect(bodies.length).toBeGreaterThanOrEqual(2);
      fixture.set({ text: 'After compaction.' });
      await runtime.submit({
        inputId: randomUUID(),
        kind: 'prompt',
        text: 'Continue after compaction.',
      });
      await expect.poll(() => latest?.state).toBe('completed');
      expect(JSON.stringify(bodies.at(-1))).toContain('The user requested a short reply.');
      expect(JSON.stringify(bodies.at(-1))).toContain('Continue after compaction.');
      expect(bodies.at(-1)?.tools).toEqual(bodies[0].tools);
    } finally {
      await runtime?.dispose();
      await fixture.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  20000,
);
