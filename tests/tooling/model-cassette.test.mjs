import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codec, modelCassette } from '../support/model/cassette.mjs';

test('portable codec retains semantic fields and supports different roots', () => {
  const recorded = codec({ ROOT: '/tmp/first' }).encode({
    messages: [{ content: 'read /tmp/first/a.txt' }],
    temperature: 0.5,
  });
  assert.deepEqual(codec({ ROOT: '/tmp/second' }).decode(recorded), {
    messages: [{ content: 'read /tmp/second/a.txt' }],
    temperature: 0.5,
  });
});
test('record/replay preserve streaming, tool deltas and usage without secrets; no live fallback', async () => {
  const root = mkdtempSync(join(tmpdir(), 'model-cassette-')),
    file = join(root, 'fixture.json');
  const oldMode = process.env.DATA_AGENT_TEST_MODEL_MODE;
  process.env.DATA_AGENT_TEST_MODEL_MODE = 'live';
  const key = 'synthetic-secret-must-not-be-recorded';
  const first =
    'data: {"choices":[{"delta":{"tool_calls":[{"id":"call_test","function":{"name":"read","arguments":"{\\"path\\":\\"/tmp/first/a.txt\\"}"}}]}}]}\n\n';
  const second =
    'data: {"choices":[],"usage":{"prompt_tokens":13,"completion_tokens":4}}\n\ndata: [DONE]\n\n';
  let transport;
  const request = (url, payload) =>
    fetch(url + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer app-synthetic-key' },
      body: JSON.stringify(payload),
    });
  try {
    transport = await modelCassette({
      mode: 'record',
      file,
      key,
      provenance: 'synthetic-unit',
      bindings: { ROOT: '/tmp/first' },
      fetchImpl: async (_url, options) => {
        assert.equal(options.headers.Authorization, `Bearer ${key}`);
        return new Response(
          new ReadableStream({
            start(controller) {
              // Split inside the root path to verify normalization across transport chunks.
              const bytes = new TextEncoder().encode(first + second);
              controller.enqueue(bytes.slice(0, 138));
              controller.enqueue(bytes.slice(138));
              controller.close();
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        );
      },
    });
    const payload = {
      model: 'deepseek-flash',
      messages: [{ role: 'user', content: 'read /tmp/first/a.txt' }],
      tools: [{ name: 'read' }],
      stream: true,
    };
    assert.equal(await (await request(transport.baseUrl, payload)).text(), first + second);
    transport.assertComplete();
    transport.save();
    await transport.close();
    transport = undefined;
    const bytes = readFileSync(file, 'utf8');
    assert(!bytes.includes(key));
    assert(!bytes.includes('app-synthetic-key'));
    assert(!bytes.includes('/tmp/first'));
    assert(bytes.includes('synthetic-unit'));
    process.env.DATA_AGENT_TEST_MODEL_MODE = 'replay';
    transport = await modelCassette({
      mode: 'replay',
      file,
      bindings: { ROOT: '/tmp/second' },
      fetchImpl: () => {
        throw new Error('NETWORK MUST NOT RUN');
      },
    });
    assert.throws(() => transport.assertComplete(), /Missing/);
    payload.messages[0].content = 'read /tmp/second/a.txt';
    assert.equal(
      await (await request(transport.baseUrl, payload)).text(),
      (first + second).replaceAll('/tmp/first', '/tmp/second'),
    );
    transport.assertComplete();
    assert.equal((await request(transport.baseUrl, payload)).status, 400);
    assert.throws(() => transport.assertComplete(), /transport errors/);
    await transport.close();
    transport = undefined;
    transport = await modelCassette({ mode: 'replay', file, bindings: { ROOT: '/tmp/second' } });
    payload.tools.push({ name: 'write' });
    assert.match(await (await request(transport.baseUrl, payload)).text(), /mismatch/);
    assert.throws(() => transport.assertComplete(), /transport errors/);
    await assert.rejects(modelCassette({ mode: 'record', file, key }), /explicit live/);
  } finally {
    await transport?.close();
    if (oldMode === undefined) delete process.env.DATA_AGENT_TEST_MODEL_MODE;
    else process.env.DATA_AGENT_TEST_MODEL_MODE = oldMode;
    rmSync(root, { recursive: true, force: true });
  }
});

test('paths split across SSE tool/content deltas are portable without removing events', async () => {
  const { portableSse } = await import('../support/model/portable-sse.mjs');
  const fragments = ['{"path":"/pri', 'vate/tmp/a/', 'fixture.txt","again":"/private/tmp/a/x"}'];
  const raw =
    fragments
      .map(
        (argumentsPart) =>
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argumentsPart } }], content: argumentsPart } }] })}\n\n`,
      )
      .join('') + 'data: [DONE]\n\n';
  const frames = portableSse(raw, { ROOT: '/private/tmp/a' });
  assert.equal(frames.length, 4);
  const read = (stream) =>
    stream
      .filter((frame) => frame.startsWith('data: {'))
      .map((frame) => JSON.parse(frame.slice(6)).choices[0].delta);
  const normalized = read(frames)
    .map((delta) => delta.tool_calls[0].function.arguments)
    .join('');
  assert.equal(normalized, '{"path":"{{ROOT}}/fixture.txt","again":"{{ROOT}}/x"}');
  assert(!normalized.includes('/private/'));
  const decoded = read(frames.map((frame) => codec({ ROOT: '/tmp/new' }).decode(frame)));
  assert.equal(
    decoded.map((delta) => delta.tool_calls[0].function.arguments).join(''),
    '{"path":"/tmp/new/fixture.txt","again":"/tmp/new/x"}',
  );
  assert.equal(
    decoded.map((delta) => delta.content).join(''),
    '{"path":"/tmp/new/fixture.txt","again":"/tmp/new/x"}',
  );
});
