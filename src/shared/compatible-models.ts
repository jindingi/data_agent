import { z } from 'zod';
import { executionLimits } from './tool-limits';
import type { ModelOption, ThinkingLevel } from './runtime';
import { providerDefinition, type CompatibleProvider } from './providers';

export const compatibleModelSchema = z
  .object({
    model: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(200),
    contextWindow: z.number().int().min(32_768).max(10_000_000),
    maxTokens: z.number().int().min(32).max(1_000_000),
    reasoning: z.boolean(),
    vision: z.boolean(),
    profile: z.enum(['basic', 'openai', 'deepseek', 'openrouter']),
  })
  .strict()
  .refine((v) => v.maxTokens <= v.contextWindow - executionLimits.compactionReserveTokens, {
    message: '最大输出须小于上下文窗口扣除压缩预留后的空间',
    path: ['maxTokens'],
  })
  .refine((v) => v.profile !== 'basic' || !v.reasoning, {
    message: '基础兼容配置不启用可配置思考，请选择对应服务配置',
    path: ['reasoning'],
  });
export type CompatibleModel = z.infer<typeof compatibleModelSchema>;
export const compatibleConfigSchema = z
  .object({ schemaVersion: z.literal(1), models: z.array(compatibleModelSchema).max(100) })
  .strict()
  .refine((v) => new Set(v.models.map((m) => m.model)).size === v.models.length, {
    message: '模型 ID 不能重复',
  });
export function compatibleThinkingMap(model: CompatibleModel) {
  return model.profile === 'deepseek'
    ? { minimal: null, medium: null, xhigh: null, max: 'max' as const }
    : { minimal: null, xhigh: null, max: null };
}
export function compatibleModelOption(
  provider: CompatibleProvider,
  model: CompatibleModel,
): ModelOption {
  const map = compatibleThinkingMap(model);
  const definition = providerDefinition(provider);
  const levels: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  return {
    ...model,
    provider,
    verified: false,
    thinkingLevels: model.reasoning
      ? levels.filter((level) => map[level as keyof typeof map] !== null)
      : ['off'],
    api: 'api' in definition ? definition.api : undefined,
  };
}
