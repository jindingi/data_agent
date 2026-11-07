import { AppError } from './errors';
import type { ModelOption, ThinkingLevel } from './runtime';

/** A provider override keeps the built-in API protocol and model catalog. */
export function normalizeEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new AppError('INVALID_ENDPOINT', '请输入完整的 API Base URL');
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new AppError(
      'INVALID_ENDPOINT',
      '地址须使用 HTTPS（本机可使用 HTTP），且不能包含凭证、查询参数或片段',
    );
  return url.href.replace(/\/+$/, '');
}

/** Product defaults, not a claim about equal reasoning budgets across providers. */
export function recommendedThinking(model?: ModelOption): ThinkingLevel {
  const levels = model?.thinkingLevels ?? ['off'];
  if (model?.provider === 'deepseek' && levels.includes('high')) return 'high';
  return levels.includes('medium') ? 'medium' : (levels.find((level) => level !== 'off') ?? 'off');
}

export function thinkingDescription(model: ModelOption): string {
  if (!model.reasoning) return '此模型不提供可配置的思考级别。';
  if (model.api === 'google-generative-ai' || model.api === 'anthropic-messages')
    return '级别按具体模型映射为思考预算或 effort。相同级别不代表相同 token 数；较高级别可能增加用量和等待时间。';
  return '可选级别由当前模型决定。不同模型的同名级别不等价，实际用量由模型决定。';
}
