import { afterEach, expect, it, vi } from 'vitest';
import { normalizeEndpoint, recommendedThinking } from '../../../src/shared/model-configuration';
import { testModelConnection } from '../../../src/agent/model-connection';
import { createModelRuntime, modelCatalog } from '../../../src/agent/models';

afterEach(() => vi.unstubAllGlobals());
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
    recommendedThinking(catalog.find((m) => m.provider === 'openai' && m.model === 'gpt-4o')),
  ).toBe('off');
  expect(
    recommendedThinking(
      catalog.find((m) => m.provider === 'anthropic' && m.model === 'claude-sonnet-4-5'),
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
    [403, 'MODEL_AUTH'],
    [404, 'MODEL_NOT_FOUND'],
    [429, 'MODEL_RATE_LIMIT'],
    [500, 'MODEL_RESPONSE'],
  ] as const) {
    status = code;
    await expect(testModelConnection(config)).rejects.toMatchObject({ code: expected });
  }
  status = 200;
  expect(await testModelConnection(config)).toBeGreaterThanOrEqual(0);
  expect(calls).toHaveLength(6); // No automatic retries or sessions.
  expect(calls.every((c) => c.url === 'https://probe.example/v1/chat/completions')).toBe(true);
  expect(calls.at(-1)?.body.messages).toEqual([{ role: 'user', content: 'Reply with OK.' }]);
  expect(calls.at(-1)?.body.max_tokens).toBe(32);
  expect(calls.at(-1)?.body.tools).toBeUndefined();
  vi.stubGlobal('fetch', async () => {
    throw new Error('secret-synthetic-key');
  });
  await expect(testModelConnection(config)).rejects.toMatchObject({ code: 'MODEL_CONNECTION' });
});
