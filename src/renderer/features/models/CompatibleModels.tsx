import { compatibleModelSchema, type CompatibleModel } from '../../../shared/compatible-models';
import type { CompatibleProvider } from '../../../shared/providers';
import type { ModelController } from './use-model-settings';
import type { ConnectionDraft } from './ProviderConnection';
import { Button } from '../../components/ui/button';
import { ModelPicker } from './ModelPicker';
import { useState } from 'react';

export function CompatibleModels({
  provider,
  controller,
  draft,
  update,
  disabled,
}: {
  provider: CompatibleProvider;
  controller: ModelController;
  draft: ConnectionDraft;
  update: (patch: Partial<ConnectionDraft>) => void;
  disabled: boolean;
}) {
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const value = draft.modelDraft ?? {
    model: '',
    name: '',
    contextWindow: 131072,
    maxTokens: 16384,
    profile: 'basic',
    reasoning: false,
    vision: false,
  };
  const models = controller.value?.compatibleModels[provider] ?? [];
  const templates =
    controller.value?.modelTemplates.filter(
      (m) =>
        m.model === 'deepseek-flash' ||
        m.model === 'deepseek/deepseek-v4.1-flash' ||
        m.model === 'openai/gpt-4o-mini',
    ) ?? [];
  function change(patch: Partial<CompatibleModel>) {
    update({ modelDraft: { ...value, ...patch } });
    setError('');
    setNotice('');
  }
  async function save() {
    const parsed = compatibleModelSchema.safeParse({
      ...value,
      name: value.name.trim() || value.model,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? '模型配置无效');
      return;
    }
    const next = [...models.filter((m) => m.model !== parsed.data.model), parsed.data];
    if (await controller.change({ type: 'models.compatible', provider, models: next })) {
      setNotice('模型配置已保存，请在下方选择模型。');
      setError('');
    }
  }
  return (
    <section className="settings-section" aria-label="兼容模型配置">
      <h3>兼容模型</h3>
      <p>可手动填写 ID，无需模型列表。上下文和能力须与服务一致；连接测试不验证全部能力。</p>
      {controller.value?.compatibleErrors[provider] && (
        <p role="alert">{controller.value.compatibleErrors[provider]}</p>
      )}
      {!!controller.value?.discoveredIds[provider]?.length && (
        <>
          <p>从接口列表填写 ID，再确认下方能力：</p>
          <ModelPicker
            label="从列表填写模型"
            models={controller.value.discoveredIds[provider].map((id) => ({
              provider,
              model: id,
              name: id,
              reasoning: false,
              vision: false,
              verified: false,
              thinkingLevels: ['off'],
            }))}
            disabled={disabled}
            onSelect={async (m) => change({ model: m.model, name: m.name })}
          />
        </>
      )}
      {!!models.length && (
        <label>
          编辑已保存的模型
          <select
            aria-label="编辑兼容模型"
            value=""
            disabled={disabled}
            onChange={(e) => {
              const found = models.find((m) => m.model === e.target.value);
              if (found) change(found);
            }}
          >
            <option value="">选择要编辑的模型…</option>
            {models.map((m) => (
              <option key={m.model} value={m.model}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        能力模板
        <select
          aria-label="模型能力模板"
          disabled={disabled}
          value=""
          onChange={(e) => {
            const template = templates[Number(e.target.value)];
            if (!template?.contextWindow) return;
            change({
              model: value.model || template.model,
              name: value.name || template.name,
              contextWindow: template.contextWindow,
              maxTokens: Math.min(template.maxTokens ?? 16384, 16384),
              reasoning: template.reasoning,
              vision: template.vision,
              profile: template.provider === 'deepseek' ? 'deepseek' : 'openrouter',
            });
          }}
        >
          <option value="">手动配置，或选择模板填入能力…</option>
          {templates.map((m, i) => (
            <option key={`${m.provider}/${m.model}`} value={i}>
              {m.provider} / {m.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        模型 ID
        <input
          aria-label="兼容模型 ID"
          value={value.model}
          disabled={disabled}
          onChange={(e) => change({ model: e.target.value })}
          spellCheck={false}
        />
      </label>
      <label>
        显示名称
        <input
          aria-label="兼容模型名称"
          value={value.name}
          disabled={disabled}
          onChange={(e) => change({ name: e.target.value })}
        />
      </label>
      <label>
        上下文窗口（tokens）
        <input
          aria-label="模型上下文窗口"
          type="number"
          min={32768}
          max={10000000}
          value={value.contextWindow}
          disabled={disabled}
          onChange={(e) => change({ contextWindow: Number(e.target.value) })}
        />
      </label>
      <label>
        模型最大输出（tokens）
        <input
          aria-label="模型最大输出"
          type="number"
          min={32}
          value={value.maxTokens}
          disabled={disabled}
          onChange={(e) => change({ maxTokens: Number(e.target.value) })}
        />
      </label>
      <p>初始 131072 / 16384 是可编辑配置值，并非接口发现结果。实际单次输出还受工作台上限约束。</p>
      <label>
        服务兼容配置
        <select
          aria-label="服务兼容配置"
          value={value.profile}
          disabled={disabled}
          onChange={(e) =>
            change({
              profile: e.target.value as CompatibleModel['profile'],
              ...(e.target.value === 'basic' ? { reasoning: false } : {}),
            })
          }
        >
          <option value="basic">基础文本兼容</option>
          <option value="openai">OpenAI</option>
          <option value="deepseek">DeepSeek</option>
          <option value="openrouter">OpenRouter</option>
        </select>
      </label>
      <label className="compatible-model-toggle">
        <input
          type="checkbox"
          checked={value.reasoning}
          disabled={disabled || value.profile === 'basic'}
          onChange={(e) => change({ reasoning: e.target.checked })}
        />
        启用可配置思考
      </label>
      <label className="compatible-model-toggle">
        <input
          type="checkbox"
          checked={value.vision}
          disabled={disabled}
          onChange={(e) => change({ vision: e.target.checked })}
        />
        支持图片输入
      </label>
      <div className="key-actions">
        <Button size="sm" disabled={disabled} onClick={() => void save()}>
          保存模型配置
        </Button>
        {models.some((m) => m.model === value.model) && (
          <Button
            size="sm"
            variant="destructive"
            disabled={disabled}
            onClick={async () => {
              if (
                await controller.change({
                  type: 'models.compatible',
                  provider,
                  models: models.filter((m) => m.model !== value.model),
                })
              )
                setNotice('模型配置已移除；历史与已提交任务保留。');
            }}
          >
            移除模型配置
          </Button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
