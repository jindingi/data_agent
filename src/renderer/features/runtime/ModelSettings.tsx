import { useState } from 'react';
import type { ModelSettings as Settings, ThinkingLevel } from '../../../shared/runtime';
import { request } from '../../lib/desktop';
import { Button } from '../../components/ui/button';

export function ModelSettings({
  value,
  onChange,
  onError,
}: {
  value?: Settings;
  onChange: (value: Settings) => void;
  onError: (message: string) => void;
}) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState('');
  const model = value?.models.find(
    (model) => model.provider === value.selected.provider && model.model === value.selected.model,
  );
  const labels = {
    off: '关闭',
    minimal: '最少',
    low: '低',
    medium: '中',
    high: '高',
    xhigh: '更高',
    max: '最高',
  };
  async function save(remove = false) {
    if (!value) return;
    setBusy(true);
    setSaved('');
    try {
      const result = await request({
        type: 'models.key',
        provider: value.selected.provider,
        key: remove ? '' : key,
      });
      setKey('');
      onChange(result);
      setSaved(remove ? '已移除凭证' : 'API key 已保存到系统加密存储');
    } catch (error) {
      onError(error instanceof Error ? error.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="settings-section model-settings">
      <h3>模型连接</h3>
      <label>
        模型
        <select
          aria-label="选择模型"
          disabled={!value || busy}
          value={value ? JSON.stringify(value.selected) : ''}
          onChange={async (event) => {
            setKey('');
            setSaved('');
            setBusy(true);
            try {
              onChange(
                await request({
                  type: 'models.select',
                  model: JSON.parse(event.target.value),
                }),
              );
            } catch (error) {
              onError(error instanceof Error ? error.message : '选择失败');
            } finally {
              setBusy(false);
            }
          }}
        >
          <option value="" disabled>
            正在读取内置模型…
          </option>
          {value?.models.map((model) => (
            <option
              key={`${model.provider}/${model.model}`}
              value={JSON.stringify({ provider: model.provider, model: model.model })}
            >
              {model.provider} · {model.name}
              {model.reasoning ? ' · 思考' : ''}
            </option>
          ))}
        </select>
      </label>
      {model && (
        <p data-testid="model-verification">
          {model.verified ? '已验证基本流程 · macOS / DeepSeek-V41-Flash' : '未验证兼容性'} ·{' '}
          {model.vision ? '模型支持图片输入' : '模型不支持图片输入'}。图表均可在本机展示。
        </p>
      )}
      {model?.reasoning && model.thinkingLevels.length > 1 && (
        <label>
          思考级别
          <select
            aria-label="思考级别"
            value={value?.thinkingLevel}
            disabled={busy}
            onChange={async (event) => {
              setBusy(true);
              try {
                onChange(
                  await request({
                    type: 'models.thinking',
                    level: event.target.value as ThinkingLevel,
                  }),
                );
              } catch (error) {
                onError(error instanceof Error ? error.message : '设置失败');
              } finally {
                setBusy(false);
              }
            }}
          >
            {model.thinkingLevels.map((level) => (
              <option key={level} value={level}>
                {labels[level]}
              </option>
            ))}
          </select>
        </label>
      )}
      <p>模型、凭证和思考级别的更改用于之后提交的任务。</p>
      <p>
        所选提供方：{value?.selected.provider ?? '…'} ·{' '}
        {value?.configuredProviders.includes(value.selected.provider) ? '已配置凭证' : '未配置凭证'}
      </p>
      <label>
        API key
        <input
          aria-label="API key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="输入新的 API key"
          value={key}
          onChange={(event) => setKey(event.target.value)}
        />
      </label>
      <div className="key-actions">
        <Button
          size="sm"
          disabled={!key.trim() || busy || !value?.encryptionAvailable}
          onClick={() => void save()}
        >
          保存凭证
        </Button>
        {value?.configuredProviders.includes(value.selected.provider) && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save(true)}>
            移除凭证
          </Button>
        )}
      </div>
      <p role="status">
        {saved ||
          (!value?.encryptionAvailable && value
            ? '系统安全存储不可用，暂时无法保存凭证。'
            : '凭证仅提供给执行所选模型的 Agent 进程。')}
      </p>
    </div>
  );
}
