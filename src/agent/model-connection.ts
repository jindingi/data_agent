import { AppError } from '../shared/errors';
import type { ModelChoice } from '../shared/runtime';
import { normalizeEndpoint } from '../shared/model-configuration';
import { createModelRuntime } from './models';

/** One bounded, isolated SDK request. No conversation, tools, files, or persisted response. */
export async function testModelConnection(config: {
  model: ModelChoice;
  apiKey: string;
  baseUrl?: string;
}): Promise<number> {
  const started = Date.now();
  const signal = AbortSignal.timeout(20_000);
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
    const result = await runtime.completeSimple(
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
          const response = await fetch(input, init);
          status = response.status;
          return response;
        },
        onResponse: (response) => {
          status = response.status;
        },
      },
    );
    if (result.stopReason === 'error' || result.stopReason === 'aborted' || !result.content.length)
      throw new Error('Incomplete model response');
    return Date.now() - started;
  } catch {
    // Never forward provider error bodies: they may echo credentials or request headers.
    if (signal.aborted) throw new AppError('MODEL_TIMEOUT', '模型请求超时，请检查地址或稍后重试');
    if (status === 401 || status === 403)
      throw new AppError('MODEL_AUTH', '鉴权失败，请检查 API key 及模型访问权限');
    if (status === 404)
      throw new AppError('MODEL_NOT_FOUND', '地址或模型不存在，请检查 Base URL 和模型名称');
    if (status === 429) throw new AppError('MODEL_RATE_LIMIT', '提供方限流或额度不足，请稍后重试');
    if (status && status >= 400)
      throw new AppError(
        'MODEL_RESPONSE',
        `提供方返回 HTTP ${status}，请检查模型协议、参数或服务状态`,
      );
    throw new AppError('MODEL_CONNECTION', '未取得有效模型响应，请检查网络、Base URL 和 API 协议');
  }
}
