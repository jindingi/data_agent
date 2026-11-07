import { useId, useState, type Dispatch, type SetStateAction } from 'react';
import type { ModelController } from './use-model-settings';
import { normalizeEndpoint } from '../../../shared/model-configuration';
import { Button } from '../../components/ui/button';
import { request } from '../../lib/desktop';

export interface ConnectionDraft {
  key: string;
  baseUrl: string;
  editing: boolean;
}
export type ConnectionDrafts = Record<string, ConnectionDraft>;
export function ProviderConnection({
  controller,
  drafts,
  setDrafts,
}: {
  controller: ModelController;
  drafts: ConnectionDrafts;
  setDrafts: Dispatch<SetStateAction<ConnectionDrafts>>;
}) {
  const { value, busy, change } = controller;
  const savedKeyId = useId();
  const [provider, setProvider] = useState(value?.selected.provider ?? 'deepseek');
  const [testModel, setTestModel] = useState('');
  const [visible, setVisible] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const models = value?.models.filter((m) => m.provider === provider) ?? [];
  const model =
    models.find((m) => m.model === testModel) ??
    models.find((m) => m.model === value?.selected.model) ??
    models[0];
  const configured = value?.configuredProviders.includes(provider) ?? false;
  const savedEndpoint = value?.endpoints[provider] ?? '';
  const draft = drafts[provider] ?? { key: '', baseUrl: savedEndpoint, editing: false };
  const dirty = !!draft.key || draft.baseUrl !== savedEndpoint;
  const locked = busy || testing;
  const providers = [...new Set(value?.models.map((m) => m.provider))].sort(
    (a, b) =>
      Number(value?.configuredProviders.includes(b)) -
        Number(value?.configuredProviders.includes(a)) || a.localeCompare(b),
  );
  function update(patch: Partial<ConnectionDraft>) {
    setDrafts((all) => ({ ...all, [provider]: { ...draft, ...patch } }));
    setNotice('');
    setError('');
    setConfirmRemove(false);
  }
  function reset() {
    setDrafts((all) => {
      const next = { ...all };
      delete next[provider];
      return next;
    });
    setVisible(false);
    setConfirmRemove(false);
  }
  async function save() {
    setError('');
    setNotice('');
    try {
      const baseUrl = draft.baseUrl.trim() ? normalizeEndpoint(draft.baseUrl) : '';
      const result = await change({
        type: 'models.connection',
        provider,
        baseUrl,
        ...(draft.key.trim() ? { key: draft.key } : {}),
      });
      if (result) {
        reset();
        setNotice('API key 已保存，连接尚未测试');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    }
  }
  async function test() {
    if (!model) return;
    setTesting(true);
    setError('');
    setNotice('');
    try {
      const result = await request({
        type: 'models.test',
        model: { provider, model: model.model },
      });
      setNotice(
        `${model.name} 连接测试通过（${(result.elapsedMs / 1000).toFixed(1)} 秒）。已收到模型内容并结束探测，不代表完整兼容性。`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : '连接测试失败');
    } finally {
      setTesting(false);
    }
  }
  return (
    <section className="settings-section model-settings" aria-labelledby="provider-heading">
      <h3 id="provider-heading">提供方连接</h3>
      <p>管理连接不会切换默认模型。地址与凭证需手动保存；未保存的编辑在本次应用运行期间保留。</p>
      <label>
        提供方
        <select
          aria-label="连接提供方"
          disabled={locked}
          value={provider}
          onChange={(e) => {
            setProvider(e.target.value);
            setTestModel('');
            setVisible(false);
            setNotice('');
            setError('');
            setConfirmRemove(false);
          }}
        >
          {providers.map((p) => (
            <option key={p} value={p}>
              {p}
              {value?.configuredProviders.includes(p) ? ' · 已配置' : ''}
              {drafts[p]?.key || (drafts[p] && drafts[p].baseUrl !== (value?.endpoints[p] ?? ''))
                ? ' · 未保存'
                : ''}
            </option>
          ))}
        </select>
      </label>
      <label>
        API Base URL
        <input
          aria-label="API Base URL"
          disabled={locked}
          value={draft.baseUrl}
          placeholder={model?.baseUrl || '使用内置地址'}
          onChange={(e) => update({ baseUrl: e.target.value })}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <div className="connection-endpoint">
        <span>
          内置地址：{model?.baseUrl || '由提供方 SDK 决定'} · 协议：{model?.api || '内置协议'}
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={locked || !draft.baseUrl}
          onClick={() => update({ baseUrl: '' })}
        >
          恢复默认地址
        </Button>
      </div>
      {draft.baseUrl !== savedEndpoint && (
        <p>地址已变更，请重新输入此地址使用的 Key 后保存。凭证将发送到上方地址。</p>
      )}
      {configured && !draft.editing ? (
        <div className="saved-credential">
          <label htmlFor={savedKeyId}>API key</label>
          <div className="saved-credential-controls">
            <input
              id={savedKeyId}
              aria-label="已保存 API key"
              type="password"
              value="********"
              readOnly
            />
            <Button
              size="sm"
              variant="outline"
              disabled={locked}
              onClick={() => update({ editing: true })}
            >
              更换 Key
            </Button>
          </div>
        </div>
      ) : (
        <>
          <label>
            API key
            <input
              aria-label="API key"
              disabled={locked}
              type={visible ? 'text' : 'password'}
              autoComplete="off"
              spellCheck={false}
              placeholder="输入 API key"
              value={draft.key}
              onChange={(e) => update({ key: e.target.value })}
            />
          </label>
          <Button size="sm" variant="ghost" disabled={locked} onClick={() => setVisible(!visible)}>
            {visible ? '隐藏 Key' : '显示 Key'}
          </Button>
        </>
      )}
      <div className="key-actions">
        <Button
          size="sm"
          disabled={locked || !dirty || !value?.encryptionAvailable}
          onClick={() => void save()}
        >
          保存凭证
        </Button>
        {(dirty || draft.editing) && (
          <Button
            size="sm"
            variant="ghost"
            disabled={locked}
            onClick={() => {
              reset();
              setError('');
              setNotice('已取消编辑');
            }}
          >
            取消编辑
          </Button>
        )}
        {configured && (
          <Button
            size="sm"
            variant="ghost"
            disabled={locked}
            onClick={() => setConfirmRemove(true)}
          >
            移除凭证
          </Button>
        )}
      </div>
      {confirmRemove && (
        <div className="credential-removal" role="group" aria-label="确认移除凭证">
          <p>
            移除 {provider} 的凭证？此提供方所有模型的新任务将不可用，已运行或排队的任务不受影响。
          </p>
          <Button
            size="sm"
            variant="destructive"
            disabled={locked}
            onClick={async () => {
              if (await change({ type: 'models.key', provider, key: '' })) {
                reset();
                setNotice('已移除凭证');
              }
            }}
          >
            确认移除凭证
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>
            取消移除
          </Button>
        </div>
      )}
      {!value?.encryptionAvailable && <p role="alert">系统安全存储不可用，无法保存凭证。</p>}
      <label>
        测试模型
        <select
          aria-label="测试模型"
          value={model?.model ?? ''}
          disabled={locked}
          onChange={(e) => {
            setTestModel(e.target.value);
            setNotice('');
            setError('');
          }}
        >
          {models.map((m) => (
            <option key={m.model} value={m.model}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <p>
        收到有效模型内容即结束探测，最多等待 20 秒，输出上限 32 token。
        可能产生少量费用，不发送会话或文件。
      </p>
      <Button
        size="sm"
        variant="outline"
        disabled={locked || dirty || !configured}
        onClick={() => void test()}
      >
        {testing ? '正在测试模型…' : '测试模型连接'}
      </Button>
      {dirty && <p>请先保存或取消编辑，再测试连接。</p>}
      {!configured && <p>保存 API key 后可测试连接。</p>}
      {error && (
        <p role="alert" className="maintenance-error">
          {error}
        </p>
      )}
      <p role="status" aria-live="polite">
        {notice}
      </p>
    </section>
  );
}
