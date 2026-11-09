import { AppError } from './errors';
import { z } from 'zod';

export const compatibleProviderSchema = z.enum([
  'openai-chat-compatible',
  'openai-responses-compatible',
]);
export type CompatibleProvider = z.infer<typeof compatibleProviderSchema>;
export function isCompatibleProvider(id: string): id is CompatibleProvider {
  return compatibleProviderSchema.safeParse(id).success;
}

export const PROVIDERS = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com' },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
  {
    id: 'openai-chat-compatible',
    name: 'OpenAI Compatible · Chat Completions',
    baseUrl: 'https://api.openai.com/v1',
    api: 'openai-completions',
  },
  {
    id: 'openai-responses-compatible',
    name: 'OpenAI Compatible · Responses',
    baseUrl: 'https://api.openai.com/v1',
    api: 'openai-responses',
  },
] as const;
export function providerDefinition(id: string) {
  const provider = PROVIDERS.find((p) => p.id === id);
  if (!provider) throw new AppError('UNKNOWN_PROVIDER', '不支持此模型提供方');
  return provider;
}
