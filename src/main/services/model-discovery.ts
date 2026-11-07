import { z } from 'zod';
import { AppError } from '../../shared/errors';
import { normalizeEndpoint } from '../../shared/model-configuration';

const listing = z.object({
  data: z
    .array(
      z.object({
        id: z.string().min(1).max(200),
        supported_parameters: z.array(z.string()).optional(),
        architecture: z.object({ output_modalities: z.array(z.string()).optional() }).optional(),
      }),
    )
    .max(10000),
});
/** Fetch metadata only. No redirects, response bodies in errors, or credential persistence. */
export async function discoverModelIds(
  baseUrl: string,
  key: string,
  fetcher: typeof fetch = fetch,
): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetcher(`${normalizeEndpoint(baseUrl)}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AppError(
        'MODEL_LIST_HTTP',
        response.status === 401 || response.status === 403
          ? '模型列表鉴权失败，请检查 API key 与地址。'
          : `获取模型列表失败（HTTP ${response.status}），请检查地址或稍后重试。`,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty body');
    let size = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 8_000_000) throw new Error('Oversized model catalog');
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
    }
    const body = listing.parse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    return [
      ...new Set(
        body.data
          .filter(
            (model) =>
              !model.id.endsWith(':batch') &&
              (!model.supported_parameters || model.supported_parameters.includes('tools')) &&
              (!model.architecture?.output_modalities ||
                model.architecture.output_modalities.includes('text')),
          )
          .map((model) => model.id),
      ),
    ];
  } catch (error) {
    if (error instanceof AppError) throw error;
    // Raw network/schema errors may contain URLs, credentials or untrusted response bodies.
    throw new AppError(
      'MODEL_LIST_FAILED',
      controller.signal.aborted
        ? '获取模型列表超时，请稍后重试。'
        : '无法获取有效模型列表，请检查地址、网络及 /models 接口。',
    );
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
