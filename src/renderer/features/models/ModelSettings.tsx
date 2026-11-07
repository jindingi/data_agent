import { useId, useState } from 'react';
import type { ThinkingLevel } from '../../../shared/runtime';
import { recommendedThinking, thinkingDescription } from '../../../shared/model-configuration';
import type { ModelController } from './use-model-settings';
import { Button } from '../../components/ui/button';

const labels = {
  off: '关闭',
  minimal: '最少',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '更高',
  max: '最高',
};
export function ModelSettings({
  controller,
  provider,
  disabled,
}: {
  controller: ModelController;
  provider: string;
  disabled: boolean;
}) {
  const { value, busy, change } = controller;
  const thinkingId = useId();
  const [search, setSearch] = useState('');
  const matches =
    value?.models.filter(
      (m) =>
        m.provider === provider &&
        `${m.provider} ${m.name} ${m.model}`.toLowerCase().includes(search.trim().toLowerCase()),
    ) ?? [];
  const providers = [...new Set(matches.map((m) => m.provider))].sort(
    (a, b) =>
      Number(value?.configuredProviders.includes(b)) -
        Number(value?.configuredProviders.includes(a)) || a.localeCompare(b),
  );
  const model = value?.models.find(
    (m) =>
      m.provider === provider &&
      m.provider === value.selected.provider &&
      m.model === value.selected.model,
  );
  return (
    <section className="settings-section model-settings" aria-labelledby="default-model-heading">
      <h3 id="default-model-heading">默认模型</h3>
      <p>选择后自动保存，用于之后提交的任务；运行中与已排队任务保持原配置。</p>
      <label>
        搜索模型
        <input
          aria-label="搜索模型"
          placeholder="模型名称或提供方"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </label>
      {matches.length ? (
        <label>
          模型
          <select
            aria-label="选择模型"
            size={search.trim() ? 5 : 1}
            disabled={!value || busy || disabled}
            value={model ? JSON.stringify(value!.selected) : ''}
            onChange={(e) =>
              void change({ type: 'models.select', model: JSON.parse(e.target.value) })
            }
          >
            <option value="" disabled>
              选择此提供方的模型
            </option>
            {providers.map((provider) => (
              <optgroup
                key={provider}
                label={`${provider}${value?.configuredProviders.includes(provider) ? ' · 已配置' : ''}`}
              >
                {matches
                  .filter((m) => m.provider === provider)
                  .map((m) => (
                    <option
                      key={`${m.provider}/${m.model}`}
                      value={JSON.stringify({ provider: m.provider, model: m.model })}
                    >
                      {m.name}
                      {m.reasoning ? ' · 思考' : ''}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
      ) : (
        <p role="status">没有匹配的模型，请调整搜索条件。</p>
      )}
      {model && (
        <>
          <p>
            当前：{model.provider} / {model.name}
          </p>
          <p data-testid="model-verification">
            {model.verified ? '已验证基本流程 · macOS / DeepSeek-V41-Flash' : '未验证兼容性'} ·{' '}
            {model.vision ? '支持图片输入' : '不支持图片输入'}
          </p>
          {model.reasoning && model.thinkingLevels.length > 1 && (
            <div className="thinking-setting">
              <label htmlFor={thinkingId}>思考级别</label>
              <div className="thinking-setting-controls">
                <select
                  id={thinkingId}
                  aria-label="思考级别"
                  value={value?.thinkingLevel}
                  disabled={busy || disabled}
                  onChange={(e) =>
                    void change({ type: 'models.thinking', level: e.target.value as ThinkingLevel })
                  }
                >
                  {model.thinkingLevels.map((level) => (
                    <option key={level} value={level}>
                      {labels[level]}
                      {level === recommendedThinking(model) ? '（推荐）' : ''}
                    </option>
                  ))}
                </select>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy || disabled || value?.thinkingLevel === recommendedThinking(model)}
                  onClick={() =>
                    void change({ type: 'models.thinking', level: recommendedThinking(model) })
                  }
                >
                  恢复推荐级别
                </Button>
              </div>
            </div>
          )}
          <p>{thinkingDescription(model)}</p>
        </>
      )}
    </section>
  );
}
