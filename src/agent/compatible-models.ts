import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { normalizeEndpoint } from '../shared/model-configuration';
import { AppError } from '../shared/errors';
import {
  compatibleModelSchema,
  compatibleThinkingMap,
  type CompatibleModel,
} from '../shared/compatible-models';
import { isCompatibleProvider, providerDefinition } from '../shared/providers';
import type { ModelChoice } from '../shared/runtime';

/** Resolve once for probes and sessions; protocol and auth never come from user model metadata. */
export function resolveRuntimeModel(
  runtime: ModelRuntime,
  choice: ModelChoice,
  baseUrl?: string,
  compatible?: CompatibleModel,
) {
  if (isCompatibleProvider(choice.provider)) {
    const definition = providerDefinition(choice.provider);
    const config = compatibleModelSchema.parse(compatible);
    if (config.model !== choice.model || !('api' in definition))
      throw new AppError('INVALID_MODEL_CONFIG', '模型配置与提供方不匹配');
    const chatCompat =
      config.profile === 'deepseek'
        ? {
            supportsStore: false,
            supportsDeveloperRole: false,
            maxTokensField: 'max_tokens' as const,
            requiresReasoningContentOnAssistantMessages: true,
            thinkingFormat: 'deepseek' as const,
          }
        : config.profile === 'openrouter'
          ? {
              supportsStore: false,
              supportsDeveloperRole: true,
              maxTokensField: 'max_tokens' as const,
              supportsReasoningEffort: true,
              thinkingFormat: 'openrouter' as const,
              requiresReasoningContentOnAssistantMessages: false,
            }
          : config.profile === 'basic'
            ? {
                supportsStore: false,
                supportsDeveloperRole: false,
                supportsReasoningEffort: false,
                maxTokensField: 'max_tokens' as const,
              }
            : {};
    runtime.registerProvider(choice.provider, {
      api: definition.api,
      baseUrl: normalizeEndpoint(baseUrl ?? definition.baseUrl),
      models: [
        {
          id: config.model,
          name: config.name,
          contextWindow: config.contextWindow,
          maxTokens: config.maxTokens,
          input: config.vision ? ['text', 'image'] : ['text'],
          reasoning: config.reasoning,
          thinkingLevelMap: compatibleThinkingMap(config),
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          compat:
            definition.api === 'openai-completions'
              ? chatCompat
              : { supportsDeveloperRole: config.profile !== 'deepseek' },
        },
      ],
    });
  } else {
    if (compatible) throw new AppError('INVALID_MODEL_CONFIG', '此提供方不接受兼容模型配置');
    if (baseUrl) runtime.registerProvider(choice.provider, { baseUrl: normalizeEndpoint(baseUrl) });
  }
  const model = runtime.getModel(choice.provider, choice.model);
  if (!model) throw new AppError('UNKNOWN_MODEL', '所选模型没有可用配置');
  return model;
}
