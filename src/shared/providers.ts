import { AppError } from './errors';

export const PROVIDERS = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com' },
  { id: 'openrouter', name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1' },
] as const;
export function providerDefinition(id: string) {
  const provider = PROVIDERS.find((p) => p.id === id);
  if (!provider) throw new AppError('UNKNOWN_PROVIDER', '仅支持 DeepSeek 和 OpenRouter');
  return provider;
}
