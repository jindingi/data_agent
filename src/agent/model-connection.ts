import { AppError } from '../shared/errors';
import type { ModelChoice } from '../shared/runtime';
import { normalizeEndpoint } from '../shared/model-configuration';
import { createModelRuntime } from './models';

/** One bounded, isolated SDK request. No conversation, tools, files, or persisted response. */
export async function testModelConnection(
  config: {
    model: ModelChoice;
    apiKey: string;
    baseUrl?: string;
  },
  fetcher: typeof fetch = fetch,
): Promise<number> {
  const started = Date.now();
  const controller = new AbortController();
  const { signal } = controller;
  const deadline = setTimeout(() => controller.abort(), 20_000);
  let status: number | undefined;
  try {
    const runtime = await createModelRuntime();
    if (config.baseUrl)
      runtime.registerProvider(config.model.provider, {
        baseUrl: normalizeEndpoint(config.baseUrl),
      });
    const model = runtime.getModel(config.model.provider, config.model.model);
    if (!model) throw new AppError('UNKNOWN_MODEL', '所选模型不在内置模型列表中');
    await runtime.setRuntimeApiKey(model.provider, config.apiKey);
    const stream = runtime.streamSimple(
      model,
      {
        messages: [{ role: 'user', content: 'Reply with OK.', timestamp: Date.now() }],
      },
      {
        signal,
        maxTokens: 32,
        maxRetries: 0,
        timeoutMs: 20_000,
        fetch: async (input, init) => {
          const response = await fetcher(input, init);
          status = response.status;
          return response;
        },
        onResponse: (response) => {
          status = response.status;
        },
      },
    );
    for await (const event of stream) {
      // Connectivity is established by parsed model content, not by an HTTP 200 or a role-only frame.
      // Some providers keep streaming after content; do not wait for their final usage/DONE frame.
      if ((event.type === 'text_delta' || event.type === 'thinking_delta') && event.delta.trim())
        return Date.now() - started;
      if (event.type === 'error') throw new Error('Model stream failed');
    }
    throw new Error('Model returned no content');
  } catch {
    // Never forward provider error bodies: they may echo credentials or request headers.
    if (signal.aborted) {
      if (status && status >= 200 && status < 300)
        throw new AppError(
          'MODEL_FIRST_CONTENT_TIMEOUT',
          '已连接到服务，但 20 秒内未收到有效模型内容；服务可能繁忙，请稍后重试',
        );
      throw new AppError('MODEL_TIMEOUT', '20 秒内未收到服务响应，请检查网络或 Base URL');
    }
    if (status === 401) throw new AppError('MODEL_AUTH', '鉴权失败，请检查 API key');
    if (status === 403)
      throw new AppError(
        'MODEL_FORBIDDEN',
        '模型访问被拒绝（HTTP 403），请检查地区限制或模型权限；不一定是 Key 错误',
      );
    if (status === 404)
      throw new AppError('MODEL_NOT_FOUND', '地址或模型不存在，请检查 Base URL 和模型名称');
    if (status === 429) throw new AppError('MODEL_RATE_LIMIT', '提供方限流或额度不足，请稍后重试');
    if (status === 503)
      throw new AppError('MODEL_UNAVAILABLE', '模型服务暂时不可用或繁忙（HTTP 503），请稍后重试');
    if (status && status >= 400)
      throw new AppError(
        'MODEL_RESPONSE',
        `提供方返回 HTTP ${status}，请检查模型协议、参数或服务状态`,
      );
    throw new AppError('MODEL_CONNECTION', '未取得有效模型响应，请检查网络、Base URL 和 API 协议');
  } finally {
    clearTimeout(deadline);
    controller.abort(); // Stop the probe, including any provider stream still open after first content.
  }
}
