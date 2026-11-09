import type { ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent';
import { compatibleModelSchema, type CompatibleModel } from '../shared/compatible-models';
import { isCompatibleProvider } from '../shared/providers';
import { AppError } from '../shared/errors';

/** Native custom metadata does not enter the model context. Never rewrite an existing binding. */
export function bindCompatibleHistory(
  manager: SessionManager,
  model: NonNullable<ReturnType<ModelRuntime['getModel']>>,
  config?: CompatibleModel,
) {
  const entries = manager.getEntries();
  const bound = entries.find(
    (e) => e.type === 'custom' && e.customType === 'data_agent.compatible_model',
  );
  const prior = manager
    .buildSessionProjection()
    .messages.slice()
    .reverse()
    .find((m) => m.role === 'assistant');
  const changingProvider = prior?.role === 'assistant' && prior.provider !== model.provider;
  if (
    changingProvider &&
    (isCompatibleProvider(model.provider) || isCompatibleProvider(prior.provider))
  )
    throw new AppError('MODEL_HISTORY_MISMATCH', '兼容提供方切换请新建会话，原会话历史已保留');
  if (bound?.type === 'custom') {
    const saved = bound.data as { provider?: string; config?: unknown };
    const parsed = compatibleModelSchema.safeParse(saved.config);
    if (
      !parsed.success ||
      saved.provider !== model.provider ||
      JSON.stringify(parsed.data) !== JSON.stringify(config)
    )
      throw new AppError(
        'MODEL_HISTORY_MISMATCH',
        '此会话的兼容模型配置已变化，请恢复原配置或新建会话',
      );
  } else if (config) {
    manager.appendCustomEntry('data_agent.compatible_model', { provider: model.provider, config });
  }
}
