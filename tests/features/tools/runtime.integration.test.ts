import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { SessionRuntime, type RuntimeConfig } from '../../../src/agent/session-runtime';
import { createModelRuntime } from '../../../src/agent/models';
import { type RuntimeSnapshot } from '../../../src/shared/runtime';
import { readTool } from '../../../src/agent/tools/read';

let root: string;

const active: SessionRuntime[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'data-agent-runtime-'));
  mkdirSync(join(root, 'workspace'));
  mkdirSync(join(root, 'sessions'));
});

afterEach(async () => {
  for (const runtime of active.splice(0)) await runtime.dispose();
  rmSync(root, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Runtime assertion timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function harness(
  options: {
    config?: RuntimeConfig;
    onEvent?: (snapshot: RuntimeSnapshot) => void;
    speed?: number;
  } = {},
) {
  const modelRuntime = await createModelRuntime();
  const faux = fauxProvider({
    provider: 'runtime-test',
    models: [{ id: 'stream', reasoning: true }],
    tokensPerSecond: options.speed ?? 2000,
    tokenSize: { min: 1, max: 1 },
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const config = options.config ?? {
    sessionId: randomUUID(),
    runId: randomUUID(),
    hostEpoch: randomUUID(),
    file: join(root, 'sessions/session.jsonl'),
    workspace: join(root, 'workspace'),
    piSessionId: null,
    model: { provider: 'runtime-test', model: 'stream' },
    apiKey: 'synthetic-runtime-key',
    protectedRoots: [join(root, 'sessions')],
  };
  const snapshots: RuntimeSnapshot[] = [];
  const requests: unknown[] = [];
  const contexts: unknown[] = [];
  const runtime = await SessionRuntime.create(
    config,
    (snapshot) => {
      snapshots.push(snapshot);
      options.onEvent?.(snapshot);
    },
    {
      runtime: modelRuntime,
      onRequest: (payload) => requests.push(structuredClone(payload)),
      onContext: (context) => contexts.push(structuredClone(context)),
    },
  );
  active.push(runtime);
  return {
    runtime,
    faux,
    config,
    snapshots,
    requests,
    contexts,
    finished: () =>
      waitFor(() => snapshots.some((s) => ['completed', 'failed', 'cancelled'].includes(s.state))),
  };
}

it('tools.read-bounds read is bounded and refuses sensitive paths including symlinks', async () => {
  const h = await harness();
  writeFileSync(join(root, 'workspace/large.txt'), 'x'.repeat(1_000_000));
  writeFileSync(join(root, 'workspace/.env'), 'fake-secret');
  symlinkSync(join(root, 'workspace/.env'), join(root, 'workspace/innocent.txt'));
  h.faux.setResponses([
    fauxAssistantMessage(fauxToolCall('read', { path: 'large.txt' }, { id: 'large' }), {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage(fauxToolCall('read', { path: 'innocent.txt' }, { id: 'secret' }), {
      stopReason: 'toolUse',
    }),
    fauxAssistantMessage('Finished.'),
  ]);
  await h.runtime.submit({ inputId: randomUUID(), kind: 'prompt', text: 'read' });
  await h.finished();
  const tools = h.snapshots.at(-1)!.tools;
  expect(tools.find((tool) => tool.id === 'large')!.output.length).toBeLessThan(64 * 1024);
  expect(tools.find((tool) => tool.id === 'large')!.output).toContain('截断');
  expect(tools.find((tool) => tool.id === 'secret')!.status).toBe('failed');
  expect(JSON.stringify(h.snapshots)).not.toContain('fake-secret');
  expect(readTool(h.config.workspace, []).name).toBe('read');
});
