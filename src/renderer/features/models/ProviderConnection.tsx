import { CompatibleModels } from './CompatibleModels';
import type { CompatibleModel } from '../../../shared/compatible-models';
import { isCompatibleProvider } from '../../../shared/providers';
import { useId, useState, type Dispatch, type SetStateAction } from 'react';
import type { ModelController } from './use-model-settings';
import { normalizeEndpoint } from '../../../shared/model-configuration';
import { PROVIDERS, providerDefinition } from '../../../shared/providers';
import { ModelSettings } from './ModelSettings';
import { Button } from '../../components/ui/button';
import { request } from '../../lib/desktop';

export interface ConnectionDraft {
  key: string;
  baseUrl: string;
  editing: boolean;
  modelDraft?: CompatibleModel;
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
  const [visible, setVisible] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const models = value?.models.filter((m) => m.provider === provider) ?? [];
  const model = models.find(
    (m) => m.provider === value?.selected.provider && m.model === value?.selected.model,
  );
  const configured = value?.configuredProviders.includes(provider) ?? false;
  const savedEndpoint = value?.endpoints[provider] ?? '';
  const draft = drafts[provider] ?? { key: '', baseUrl: savedEndpoint, editing: false };
  const dirty = !!draft.key || draft.baseUrl !== savedEndpoint;
  const locked = busy || testing || discovering;
  const providers = PROVIDERS.map((p) => p.id);
  const definition = providerDefinition(provider);
  let requestUrl = '';
  if ('api' in definition) {
    try {
      requestUrl = `${normalizeEndpoint(draft.baseUrl.trim() || definition.baseUrl)}/${definition.api === 'openai-responses' ? 'responses' : 'chat/completions'}`;
    } catch {
      /* Invalid drafts are reported when saved, never rendered as credential-bearing URLs. */
    }
  }
  async function discover() {
    setDiscovering(true);
    setNotice('');
    try {
      const result = await change({ type: 'models.discover', provider: definition.id });
      if (result)
        setNotice(
          `已获取 ${result.catalogs[provider]?.count ?? 0} 个兼容模型。获取列表不代表连接测试通过。`,
        );
      return result;
    } finally {
      setDiscovering(false);
    }
  }
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
        const discovered = await discover();
        if (discovered) setNotice('API key 已保存，模型列表已更新，请选择模型。');
        else setNotice('API key 已保存，获取模型列表失败，请重试。');
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
      <p>
        先选择提供方，配置地址与
        Key，再获取模型列表或配置兼容模型。选择模型后用于新任务，已运行或排队的任务不变。
      </p>
      <label>
        提供方
        <select
          aria-label="连接提供方"
          disabled={locked}
          value={provider}
          onChange={(e) => {
            setProvider(e.target.value);
            setVisible(false);
            setNotice('');
            setError('');
            setConfirmRemove(false);
          }}
        >
          {providers.map((p) => (
            <option key={p} value={p}>
              {providerDefinition(p).name}
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
          placeholder={definition.baseUrl}
          onChange={(e) => update({ baseUrl: e.target.value })}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <div className="connection-endpoint">
        <span>默认地址：{definition.baseUrl}</span>
        <Button
          size="sm"
          variant="ghost"
          disabled={locked || !draft.baseUrl}
          onClick={() => update({ baseUrl: '' })}
        >
          恢复默认地址
        </Button>
      </div>
      {isCompatibleProvider(provider) && (
        <p>
          填写 API 前缀，不要填写完整 /chat/completions 或 /responses 路径。
          {requestUrl && <span data-testid="compatible-endpoint">请求地址：{requestUrl}</span>}
        </p>
      )}
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
      <Button
        size="sm"
        variant="outline"
        disabled={locked || dirty || !configured}
        onClick={() => void discover()}
      >
        {discovering ? '正在获取模型列表…' : '获取模型列表'}
      </Button>
      {isCompatibleProvider(provider) && configured && (
        <CompatibleModels
          key={`compatible-${provider}`}
          provider={provider}
          controller={controller}
          draft={draft}
          update={update}
          disabled={locked || dirty}
        />
      )}
      {isCompatibleProvider(provider) ? (
        models.length ? (
          <ModelSettings
            key={`models-${provider}`}
            controller={controller}
            provider={provider}
            disabled={locked || dirty}
          />
        ) : (
          <p>保存兼容模型配置后，可选择模型。</p>
        )
      ) : value?.catalogs[provider] ? (
        <>
          <p>
            模型列表更新于 {new Date(value.catalogs[provider].fetchedAt).toLocaleString()}
            。仅展示接口返回且 SDK 支持的聊天/工具模型，未逐一验证。
          </p>
          {models.length ? (
            <ModelSettings
              key={provider}
              controller={controller}
              provider={provider}
              disabled={locked || dirty}
            />
          ) : (
            <p role="status">当前地址没有与 SDK 兼容的模型，请检查地址或更新 SDK。</p>
          )}
        </>
      ) : (
        <p>保存凭证并获取列表后，可选择模型。</p>
      )}
      <p>
        收到有效模型内容即结束探测，最多等待 20 秒，输出上限 32 token。
        可能产生少量费用，不发送会话或文件。
      </p>
      <Button
        size="sm"
        variant="outline"
        disabled={locked || dirty || !configured || !model}
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
