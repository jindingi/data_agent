import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai/compat';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
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
    .filter((model) => runtime.getProvider(model.provider)?.auth.apiKey)
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
      verified: model.provider === 'deepseek' && model.id === 'deepseek-flash',
    }))
    .sort(
      (a, b) =>
        (a.provider === 'deepseek'
          ? -1
          : b.provider === 'deepseek'
            ? 1
            : a.provider.localeCompare(b.provider)) || a.name.localeCompare(b.name),
    );
}
