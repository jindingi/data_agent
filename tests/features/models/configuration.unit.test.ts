import { afterEach, expect, it, vi } from 'vitest';
import { normalizeEndpoint, recommendedThinking } from '../../../src/shared/model-configuration';
import { testModelConnection } from '../../../src/agent/model-connection';
import { createModelRuntime, modelCatalog } from '../../../src/agent/models';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('validates endpoint destinations and recommends only model-supported thinking levels', async () => {
  expect(normalizeEndpoint(' https://example.com/v1/ ')).toBe('https://example.com/v1');
  expect(normalizeEndpoint('http://127.0.0.1:1234/v1')).toBe('http://127.0.0.1:1234/v1');
  for (const url of [
    'http://example.com',
    'file:///tmp',
    'https://user:key@host',
    'https://host?key=secret',
    'https://host#secret',
    'invalid',
  ])
    expect(() => normalizeEndpoint(url)).toThrow();
  const catalog = modelCatalog(await createModelRuntime());
  for (const model of catalog) expect(model.thinkingLevels).toContain(recommendedThinking(model));
  expect(
    recommendedThinking(
      catalog.find((m) => m.provider === 'deepseek' && m.model === 'deepseek-flash'),
    ),
  ).toBe('high');
  expect(
    recommendedThinking(
      catalog.find((m) => m.provider === 'openrouter' && m.model === 'openai/gpt-4o-mini'),
    ),
  ).toBe('off');
  expect(
    recommendedThinking(
      catalog.find((m) => m.provider === 'openrouter' && m.model === 'anthropic/claude-sonnet-4.5'),
    ),
  ).toBe('medium');
});
it('tests the saved endpoint through the real SDK with a bounded prompt and sanitized failures', async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  let status = 401;
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body)) });
    if (status !== 200)
      return new Response(
        JSON.stringify({ error: { message: 'secret-synthetic-key', type: 'error' } }),
        { status, headers: { 'Content-Type': 'application/json' } },
      );
    const chunk = (delta: unknown, finish_reason: string | null) =>
      `data: ${JSON.stringify({ id: 'probe', object: 'chat.completion.chunk', model: 'deepseek-flash', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
    return new Response(
      chunk({ role: 'assistant', content: 'OK' }, null) + chunk({}, 'stop') + 'data: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    );
  });
  const config = {
    model: { provider: 'deepseek', model: 'deepseek-flash' },
    apiKey: 'secret-synthetic-key',
    baseUrl: 'https://probe.example/v1',
  };
  for (const [code, expected] of [
    [401, 'MODEL_AUTH'],
    [403, 'MODEL_FORBIDDEN'],
    [404, 'MODEL_NOT_FOUND'],
    [429, 'MODEL_RATE_LIMIT'],
    [500, 'MODEL_RESPONSE'],
    [503, 'MODEL_UNAVAILABLE'],
  ] as const) {
    status = code;
    await expect(testModelConnection(config)).rejects.toMatchObject({ code: expected });
  }
  status = 200;
  expect(await testModelConnection(config)).toBeGreaterThanOrEqual(0);
  expect(calls).toHaveLength(7); // No automatic retries or sessions.
  expect(calls.every((c) => c.url === 'https://probe.example/v1/chat/completions')).toBe(true);
  expect(calls.at(-1)?.body.messages).toEqual([{ role: 'user', content: 'Reply with OK.' }]);
  expect(calls.at(-1)?.body.max_tokens).toBe(32);
  expect(calls.at(-1)?.body.tools).toBeUndefined();
  vi.stubGlobal('fetch', async () => {
    throw new Error('secret-synthetic-key');
  });
  await expect(testModelConnection(config)).rejects.toMatchObject({ code: 'MODEL_CONNECTION' });
});

it('finishes a connection probe after valid content even when the provider leaves the stream open', async () => {
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  let aborted = false;
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        const event = {
          id: 'held-open',
          object: 'chat.completion.chunk',
          model: 'deepseek-flash',
          choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }],
        };
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
        init.signal?.addEventListener(
          'abort',
          () => {
            aborted = true;
            controller.error(new DOMException('Aborted', 'AbortError'));
          },
          { once: true },
        );
      },
    });
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
  });
  const pending = testModelConnection({
    model: { provider: 'deepseek', model: 'deepseek-flash' },
    apiKey: 'synthetic',
    baseUrl: 'https://probe.example/v1',
  });
  const verdict = await Promise.race([
    pending.then(
      () => 'responded',
      () => 'failed',
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve('still-waiting-for-end'), 750)),
  ]);
  streamController?.error(new Error('fixture cleanup'));
  await pending.catch(() => {});
  expect(verdict).toBe('responded');
  expect(aborted).toBe(true);
});

it.each([false, true])(
  'distinguishes no response from an empty connected stream (connected=%s)',
  async (connected) => {
    vi.useFakeTimers();
    let entered!: () => void;
    const fetched = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      entered();
      if (!connected)
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        });
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            // A role-only SSE frame proves transport, not a working model response.
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({ id: 'empty', object: 'chat.completion.chunk', model: 'deepseek-flash', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })}\n\n`,
              ),
            );
            init.signal?.addEventListener(
              'abort',
              () => controller.error(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    });
    const outcome = testModelConnection({
      model: { provider: 'deepseek', model: 'deepseek-flash' },
      apiKey: 'synthetic',
      baseUrl: 'https://probe.example/v1',
    }).then(
      () => null,
      (error) => error,
    );
    await fetched;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await outcome).toMatchObject({
      code: connected ? 'MODEL_FIRST_CONTENT_TIMEOUT' : 'MODEL_TIMEOUT',
    });
    expect(vi.getTimerCount()).toBe(0);
  },
);

it('discovers bounded model IDs without exposing provider errors or unsupported model types', async () => {
  const { discoverModelIds } = await import('../../../src/main/services/model-discovery');
  let body: unknown = {
    data: [
      {
        id: 'chat',
        supported_parameters: ['tools'],
        architecture: { output_modalities: ['text'] },
      },
      { id: 'chat' },
      { id: 'image', architecture: { output_modalities: ['image'] } },
      { id: 'no-tools', supported_parameters: ['temperature'] },
    ],
  };
  const fetcher = vi.fn(async () => new Response(JSON.stringify(body)));
  expect(await discoverModelIds('https://example.com/v1/', 'synthetic', fetcher)).toEqual(['chat']);
  expect(fetcher.mock.calls[0]).toMatchObject([
    'https://example.com/v1/models',
    { redirect: 'error', headers: { Authorization: 'Bearer synthetic' } },
  ]);
  body = { data: [{ id: 42 }] };
  await expect(
    discoverModelIds('https://example.com/v1', 'synthetic', fetcher),
  ).rejects.toMatchObject({ code: 'MODEL_LIST_FAILED' });
  await expect(
    discoverModelIds(
      'https://example.com/v1',
      'synthetic',
      async () => new Response('secret', { status: 401 }),
    ),
  ).rejects.toMatchObject({ code: 'MODEL_LIST_HTTP' });
  expect(new Set(modelCatalog(await createModelRuntime()).map((m) => m.provider))).toEqual(
    new Set(['deepseek', 'openrouter']),
  );
});
