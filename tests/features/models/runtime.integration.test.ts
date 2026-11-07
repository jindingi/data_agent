import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai';
import { SessionRuntime, type RuntimeConfig } from '../../../src/agent/session-runtime';
import { createModelRuntime } from '../../../src/agent/models';
import { type RuntimeSnapshot } from '../../../src/shared/runtime';

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

it('models.credentials missing key and unknown model fail before session file creation', async () => {
  const h = await harness();
  await h.runtime.dispose();
  active.splice(active.indexOf(h.runtime), 1);
  const modelRuntime = await createModelRuntime();
  await expect(
    SessionRuntime.create({ ...h.config, apiKey: '' }, () => {}, { runtime: modelRuntime }),
  ).rejects.toThrow('API key');
  await expect(
    SessionRuntime.create(
      { ...h.config, model: { provider: 'missing', model: 'missing' } },
      () => {},
      { runtime: modelRuntime },
    ),
  ).rejects.toThrow('模型');
  expect(existsSync(h.config.file)).toBe(false);
  const errorRun = await harness();
  errorRun.faux.setResponses([
    fauxAssistantMessage(`provider echo ${errorRun.config.apiKey}`, {
      stopReason: 'error',
      errorMessage: `HTTP error: ${errorRun.config.apiKey}`,
    }),
  ]);
  await errorRun.runtime.submit({
    inputId: randomUUID(),
    kind: 'prompt',
    text: 'synthetic provider failure',
  });
  await errorRun.finished();
  expect(errorRun.snapshots.at(-1)?.state).toBe('failed');
  expect(JSON.stringify(errorRun.snapshots)).not.toContain(errorRun.config.apiKey);
  expect(readFileSync(errorRun.config.file, 'utf8')).not.toContain(errorRun.config.apiKey);
});
