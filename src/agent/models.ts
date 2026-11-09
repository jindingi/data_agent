import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/compat';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { PROVIDERS } from '../shared/providers';
import type { ModelOption } from '../shared/runtime';

export async function createModelRuntime() {
  return ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: new InMemoryModelsStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
}
export function modelCatalog(runtime: ModelRuntime): ModelOption[] {
  return runtime
    .getModels()
    .filter((model) => PROVIDERS.some((p) => p.id === model.provider))
    .map((model) => ({
      provider: model.provider,
      model: model.id,
      name:
        model.provider === 'deepseek' && model.id === 'deepseek-flash'
          ? 'DeepSeek-V41-Flash'
          : model.name,
      reasoning: model.reasoning,
      vision: model.input.includes('image'),
      thinkingLevels: getSupportedThinkingLevels(model),
      baseUrl: model.baseUrl,
      api: model.api,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      verified: model.provider === 'deepseek' && model.id === 'deepseek-flash',
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
}
