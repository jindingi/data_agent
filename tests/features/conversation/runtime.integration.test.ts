import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxThinking,
  fauxText,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { SessionRuntime, type RuntimeConfig } from '../../../src/agent/session-runtime';
import { createModelRuntime } from '../../../src/agent/models';
import { readHistory } from '../../../src/agent/history';
import { acceptSnapshot, type RuntimeSnapshot } from '../../../src/shared/runtime';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { envelope } from '../../../src/agent/input-identity';

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

it('conversation.streaming real SDK streams thinking, text and matching read tool results', async () => {
  const h = await harness({ speed: 250 });
  writeFileSync(join(root, 'workspace/sample.txt'), 'synthetic file content');
  h.faux.setResponses([
    fauxAssistantMessage(
      [
        fauxThinking('Inspect the selected source first.'),
        fauxText('Reading the source.'),
        fauxToolCall('read', { path: 'sample.txt' }, { id: 'read-1' }),
      ],
      { stopReason: 'toolUse' },
    ),
    fauxAssistantMessage([
      fauxThinking('The tool returned its result.'),
      fauxText('## Finished\n\nThe file was read.'),
    ]),
  ]);
  await h.runtime.submit({ inputId: randomUUID(), kind: 'prompt', text: 'Read the file.' });
  await h.finished();
  expect(h.snapshots.at(-1)?.state).toBe('completed');
  const final = h.snapshots.at(-1)!;
  expect(final.tools).toHaveLength(1);
  expect(final.tools[0]).toMatchObject({
    id: 'read-1',
    status: 'completed',
    output: 'synthetic file content',
  });
  expect(
    h.snapshots.some((snapshot) =>
      snapshot.messages.some(
        (message) =>
          message.pending &&
          message.blocks.some((block) => block.type === 'thinking' && block.text.length > 0),
      ),
    ),
  ).toBe(true);
  expect(
    final.messages
      .filter((message) => message.role === 'assistant')
      .flatMap((message) => message.blocks)
      .filter((block) => block.type === 'toolCall'),
  ).toHaveLength(1);
  expect(final.inputs[0].state).toBe('committed');
  expect(new Set(h.snapshots.map((snapshot) => snapshot.seq)).size).toBe(h.snapshots.length);
  const earlier = JSON.stringify(h.snapshots[1]);
  h.runtime.snapshot();
  expect(JSON.stringify(h.snapshots[1])).toBe(earlier);
  expect(readFileSync(h.config.file, 'utf8')).not.toContain(h.config.apiKey);
});

it('conversation.snapshot watermark rejects stale, cross-session and previous-run snapshots', async () => {
  const h = await harness({ speed: 100 });
  h.faux.setResponses([
    fauxAssistantMessage(
      'A deliberately long response permits an in-flight refresh and snapshot capture.',
    ),
  ]);
  await h.runtime.submit({ inputId: randomUUID(), kind: 'prompt', text: 'start' });
  await waitFor(() =>
    h.snapshots.some((snapshot) => snapshot.messages.some((message) => message.pending)),
  );
  const snapshot = h.runtime.snapshot();
  expect(acceptSnapshot(null, snapshot, h.config.sessionId)).toBeNull();
  const restored = acceptSnapshot(null, snapshot, h.config.sessionId, true)!;
  expect(restored.messages.some((message) => message.pending)).toBe(true);
  expect(acceptSnapshot(restored, { ...snapshot, seq: snapshot.seq - 1 }, h.config.sessionId)).toBe(
    restored,
  );
  expect(
    acceptSnapshot(
      restored,
      { ...snapshot, sessionId: randomUUID(), seq: 999 },
      h.config.sessionId,
      true,
    ),
  ).toBe(restored);
  expect(
    acceptSnapshot(restored, { ...snapshot, runId: randomUUID(), seq: 999 }, h.config.sessionId),
  ).toBe(restored);
  const nextRun = { ...snapshot, runId: randomUUID(), seq: 0 };
  expect(acceptSnapshot(restored, nextRun, h.config.sessionId, true)).toBe(nextRun);
  expect(acceptSnapshot(nextRun, { ...snapshot, seq: 999 }, h.config.sessionId)).toBe(nextRun);
  await h.finished();
  expect(acceptSnapshot(restored, h.snapshots.at(-1)!, h.config.sessionId)?.state).toBe(
    'completed',
  );
  const queued = await harness({
    config: {
      ...h.config,
      file: join(root, 'sessions/queued.jsonl'),
      sessionId: randomUUID(),
      runId: randomUUID(),
    },
  });
  let release!: () => void;
  let entered = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  queued.faux.setResponses([
    async () => {
      entered = true;
      await gate;
      return fauxAssistantMessage('First response.');
    },
    fauxAssistantMessage('Steering response.'),
    fauxAssistantMessage('Follow-up response.'),
  ]);
  await queued.runtime.submit({
    inputId: randomUUID(),
    kind: 'prompt',
    text: 'wait for queued inputs',
  });
  try {
    await waitFor(() => entered);
    await queued.runtime.submit({ inputId: randomUUID(), kind: 'steer', text: 'same queued text' });
    await queued.runtime.submit({
      inputId: randomUUID(),
      kind: 'followUp',
      text: 'same queued text',
    });
    const inFlight = queued.runtime.snapshot();
    const pending = inFlight.queuedInputs!.filter((input) => input.kind !== 'prompt');
    expect(pending.map((input) => input.kind)).toEqual(['steer', 'followUp']);
    expect(new Set(pending.map((input) => input.inputId)).size).toBe(2);
    expect(acceptSnapshot(null, inFlight, queued.config.sessionId, true)?.queuedInputs).toEqual(
      inFlight.queuedInputs,
    );
  } finally {
    release();
  }
  await queued.finished();
  expect(queued.snapshots.at(-1)!.queuedInputs).toEqual([]);
});

it('conversation.input-identity duplicate input text keeps distinct IDs and only the outer envelope is hidden', async () => {
  const h = await harness({ speed: 300 });
  h.faux.setResponses(
    Array.from({ length: 5 }, () =>
      fauxAssistantMessage(
        'Streaming response long enough to queue steering and follow-up messages.',
      ),
    ),
  );
  const ids = Array.from({ length: 5 }, () => randomUUID());
  const literal = `[data-agent-input:${randomUUID()}]\nKeep this user-authored marker.`;
  await h.runtime.submit({ inputId: ids[0], kind: 'prompt', text: literal });
  await waitFor(() =>
    h.snapshots.some((snapshot) => snapshot.messages.some((message) => message.pending)),
  );
  for (const [i, kind] of (['steer', 'steer', 'followUp', 'followUp'] as const).entries())
    await h.runtime.submit({ inputId: ids[i + 1], kind, text: 'identical text' });
  await h.finished();
  const final = h.snapshots.at(-1)!;
  expect(final.state).toBe('completed');
  expect(final.inputs.map((input) => input.inputId)).toEqual(ids);
  expect(final.inputs.every((input) => input.state === 'committed')).toBe(true);
  expect(new Set(final.inputs.map((input) => input.entryId)).size).toBe(5);
  expect(final.messages.filter((message) => message.role === 'user')[0].blocks).toEqual([
    { type: 'text', text: literal },
  ]);
  expect(h.contexts.length).toBeGreaterThan(0);
  for (const id of ids)
    expect(JSON.stringify(h.contexts)).not.toContain(`[data-agent-input:${id}]`);
  expect(JSON.stringify(h.contexts)).toContain(literal.split('\n')[0]);
  const records = readFileSync(h.config.file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const restored = readHistory(h.config.file, h.config.workspace, records[0].id);
  expect(restored.items.filter((item) => item.role === 'user').map((item) => item.text)).toEqual([
    literal,
    ...Array(4).fill('identical text'),
  ]);
  await h.runtime.dispose();
  active.splice(active.indexOf(h.runtime), 1);
  const restarted = await harness({
    config: {
      ...h.config,
      runId: randomUUID(),
      piSessionId: records[0].id,
    },
  });
  expect(restarted.runtime.snapshot().inputs.every((input) => input.state === 'committed')).toBe(
    true,
  );
  expect(
    restarted.runtime.snapshot().messages.filter((message) => message.role === 'user'),
  ).toHaveLength(5);
  expect(restarted.faux.state.callCount).toBe(0);
  // Real native file at the disk-before-ACK boundary, plus one never-consumed input.
  const crashFile = join(root, 'sessions/crash.jsonl');
  const manager = SessionManager.open(crashFile, join(root, 'sessions'), h.config.workspace);
  const consumedId = randomUUID(),
    unknownId = randomUUID();
  manager.appendCustomEntry('data_agent.input_submitted', { inputId: consumedId, kind: 'prompt' });
  const entryId = manager.appendMessage({
    role: 'user',
    content: envelope(consumedId, 'persisted before ACK'),
    timestamp: Date.now(),
  });
  manager.appendMessage(fauxAssistantMessage('native flush'));
  manager.appendCustomEntry('data_agent.input_submitted', { inputId: unknownId, kind: 'followUp' });
  const recovery = await harness({
    config: {
      ...h.config,
      file: crashFile,
      piSessionId: manager.getSessionId(),
      runId: randomUUID(),
    },
  });
  expect(recovery.runtime.snapshot().inputs).toEqual([
    { inputId: consumedId, kind: 'prompt', state: 'committed', entryId },
    { inputId: unknownId, kind: 'followUp', state: 'unknown' },
  ]);
  expect(recovery.faux.state.callCount).toBe(0);
  const recoveredRecords = readFileSync(crashFile, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  expect(
    recoveredRecords.filter((entry) => entry.customType === 'data_agent.input_committed'),
  ).toHaveLength(1);
  expect(
    recoveredRecords.filter((entry) => entry.type === 'message' && entry.message.role === 'user'),
  ).toHaveLength(1);
});

it('conversation.request-limit request 21 never reaches the provider', async () => {
  const h = await harness();
  writeFileSync(join(root, 'workspace/limit.txt'), 'small bounded fixture');
  h.faux.setResponses(
    Array.from({ length: 25 }, (_, index) =>
      fauxAssistantMessage(fauxToolCall('read', { path: 'limit.txt' }, { id: `budget-${index}` }), {
        stopReason: 'toolUse',
      }),
    ),
  );
  await h.runtime.submit({
    inputId: randomUUID(),
    kind: 'prompt',
    text: 'exercise bounded model calls',
  });
  await h.finished();
  expect(h.faux.state.callCount).toBe(20);
  expect(h.snapshots.at(-1)?.state).toBe('failed');
  expect(h.snapshots.at(-1)?.error).toContain('20 次模型请求上限');
});
