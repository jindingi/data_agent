import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHistory } from '../../../src/agent/history';
import { SessionRuntime } from '../../../src/agent/session-runtime';
import type { RuntimeSnapshot } from '../../../src/shared/runtime';

it.each([false, true])(
  'preserves actual DeepSeek request prefixes through tools, attachments and restart (legacy=%s)',
  async (legacy) => {
    const root = mkdtempSync(join(tmpdir(), 'data-agent-cache-'));
    mkdirSync(join(root, 'workspace'));
    mkdirSync(join(root, 'sessions'));
    const firstWorkspace = legacy
      ? join(root, 'workspace/runs/old/versions/old')
      : join(root, 'workspace');
    mkdirSync(firstWorkspace, { recursive: true });
    const payloads: { messages: { role: string; content: unknown }[]; tools?: unknown }[] = [];
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      const tool = calls++ === 0;
      const delta = tool
        ? {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'read-file',
                type: 'function',
                function: { name: 'read', arguments: JSON.stringify({ path: 'missing.txt' }) },
              },
            ],
          }
        : { role: 'assistant', content: 'Done' };
      return new Response(
        `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'deepseek-flash', choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'deepseek-flash', choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\ndata: [DONE]\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    });
    let runtime: SessionRuntime | undefined;
    let snapshot: RuntimeSnapshot | undefined;
    try {
      runtime = await SessionRuntime.create(
        {
          sessionId: randomUUID(),
          runId: randomUUID(),
          hostEpoch: randomUUID(),
          file: join(root, 'sessions/session.jsonl'),
          workspace: firstWorkspace,
          piSessionId: null,
          model: { provider: 'deepseek', model: 'deepseek-flash' },
          apiKey: 'synthetic',
          protectedRoots: [],
        },
        (value) => {
          snapshot = value;
        },
        {
          onRequest: (payload) =>
            payloads.push(structuredClone(payload) as (typeof payloads)[number]),
        },
      );
      await runtime.submit({
        inputId: randomUUID(),
        kind: 'prompt',
        text: 'Read missing.txt then reply.',
      });
      await vi.waitFor(() => expect(snapshot?.state).toBe('completed'), { timeout: 5000 });
      expect(payloads).toHaveLength(2);
      expect(payloads[1].messages.slice(0, payloads[0].messages.length)).toEqual(
        payloads[0].messages,
      );
      expect(JSON.stringify(payloads)).not.toContain('执行预算');
      expect(JSON.stringify(payloads)).not.toContain('工作台运行状态');
      expect(JSON.stringify(payloads[0].messages[0])).toContain(join(root, 'workspace'));
      const file = join(root, 'sessions/session.jsonl');
      const records = readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const piSessionId = records[0].id as string;
      expect(
        records.filter(
          (record) =>
            record.type === 'custom_message' && record.customType === 'data_agent.runtime_context',
        ),
      ).toHaveLength(0);
      expect(
        readHistory(file, firstWorkspace, piSessionId).messages.filter(
          (message) => message.role === 'user',
        ),
      ).toHaveLength(1);
      await runtime.dispose();
      snapshot = undefined;
      runtime = await SessionRuntime.create(
        {
          sessionId: randomUUID(),
          runId: randomUUID(),
          hostEpoch: randomUUID(),
          file,
          workspace: join(root, 'workspace'),

          piSessionId,
          model: { provider: 'deepseek', model: 'deepseek-flash' },
          apiKey: 'synthetic',
          protectedRoots: [],
        },
        (value) => {
          snapshot = value;
        },
        {
          onRequest: (payload) =>
            payloads.push(structuredClone(payload) as (typeof payloads)[number]),
        },
      );
      await runtime.submit({
        inputId: randomUUID(),
        kind: 'prompt',
        text: 'Continue using the attached file.',
        paths: [join(root, 'new-file.csv')],
      });
      await vi.waitFor(() => expect(snapshot?.state).toBe('completed'), { timeout: 5000 });
      expect(payloads).toHaveLength(3);
      expect(payloads[2].messages.slice(0, payloads[1].messages.length)).toEqual(
        payloads[1].messages,
      );
      expect(JSON.stringify(payloads[2].messages[0])).not.toContain('new-file.csv');
      expect(JSON.stringify(payloads)).not.toContain('剩余最多');
      expect(JSON.stringify(payloads[2].messages.at(-1))).toContain('new-file.csv');
      expect(payloads[2].tools).toEqual(payloads[0].tools);
      const upgraded = readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(
        upgraded.filter((entry) => entry.customType === 'data_agent.workspace_migration'),
      ).toHaveLength(legacy ? 1 : 0);
      await runtime.dispose();
      snapshot = undefined;
      runtime = await SessionRuntime.create(
        {
          sessionId: randomUUID(),
          runId: randomUUID(),
          hostEpoch: randomUUID(),
          file,
          workspace: join(root, 'workspace'),
          piSessionId,
          model: { provider: 'deepseek', model: 'deepseek-flash' },
          apiKey: 'synthetic',
          protectedRoots: [],
        },
        (value) => {
          snapshot = value;
        },
        {
          onRequest: (payload) =>
            payloads.push(structuredClone(payload) as (typeof payloads)[number]),
        },
      );
      await runtime.submit({ inputId: randomUUID(), kind: 'prompt', text: 'Continue once more.' });
      await vi.waitFor(() => expect(snapshot?.state).toBe('completed'), { timeout: 5000 });
      expect(payloads[3].messages.slice(0, payloads[2].messages.length)).toEqual(
        payloads[2].messages,
      );
      const restored = readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(
        restored.filter((entry) => entry.customType === 'data_agent.workspace_migration'),
      ).toHaveLength(legacy ? 1 : 0);
    } finally {
      await runtime?.dispose();
      vi.unstubAllGlobals();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
