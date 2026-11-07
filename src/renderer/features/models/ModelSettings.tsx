import { useId } from 'react';
import type { ThinkingLevel } from '../../../shared/runtime';
import { recommendedThinking, thinkingDescription } from '../../../shared/model-configuration';
import type { ModelController } from './use-model-settings';
import { ModelPicker } from './ModelPicker';
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
      <ModelPicker
        models={value?.models.filter((m) => m.provider === provider) ?? []}
        selected={model}
        disabled={!value || busy || disabled}
        onSelect={(model) =>
          change({ type: 'models.select', model: { provider: model.provider, model: model.model } })
        }
      />
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
