import { useState } from 'react';
import type { ModelSettings as Settings } from '../../../shared/runtime';
import { request } from '../../lib/desktop';
import { Button } from '../../components/ui/button';

export function ModelSettings({ value, onChange, onError }: { value?: Settings; onChange: (value: Settings) => void; onError: (message: string) => void }) {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState('');
  async function save(remove = false) {
    if (!value) return;
    setBusy(true); setSaved('');
    try {
      const result = await request<Settings>({ type: 'models.key', provider: value.selected.provider, key: remove ? '' : key });
      setKey(''); onChange(result); setSaved(remove ? '已移除凭证' : 'API key 已保存到系统加密存储');
    } catch (error) { onError(error instanceof Error ? error.message : '保存失败'); } finally { setBusy(false); }
  }
  return <div className="settings-section model-settings"><h3>模型连接</h3>
    <label>模型<select aria-label="选择模型" disabled={!value || busy} value={value ? JSON.stringify(value.selected) : ''} onChange={async event => {
      setKey(''); setSaved('');
      try { onChange(await request<Settings>({ type: 'models.select', model: JSON.parse(event.target.value) })); } catch (error) { onError(error instanceof Error ? error.message : '选择失败'); }
    }}><option value="" disabled>正在读取内置模型…</option>{value?.models.map(model => <option key={`${model.provider}/${model.model}`} value={JSON.stringify({ provider: model.provider, model: model.model })}>{model.provider} · {model.name}{model.reasoning ? ' · 思考' : ''}</option>)}</select></label>
    <p>所选提供方：{value?.selected.provider ?? '…'} · {value?.configuredProviders.includes(value.selected.provider) ? '已配置凭证' : '未配置凭证'}</p>
    <label>API key<input aria-label="API key" type="password" autoComplete="off" spellCheck={false} placeholder="输入新的 API key" value={key} onChange={event => setKey(event.target.value)} /></label>
    <div className="key-actions"><Button size="sm" disabled={!key.trim() || busy || !value?.encryptionAvailable} onClick={() => void save()}>保存凭证</Button>{value?.configuredProviders.includes(value.selected.provider) && <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save(true)}>移除凭证</Button>}</div>
    <p role="status">{saved || (!value?.encryptionAvailable && value ? '系统安全存储不可用，暂时无法保存凭证。' : '凭证仅提供给执行所选模型的 Agent 进程。')}</p>
  </div>;
}
