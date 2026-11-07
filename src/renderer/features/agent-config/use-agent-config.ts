import { useCallback, useEffect, useState } from 'react';
import type { AgentConfig, AgentConfigSettings } from '../../../shared/agent-config';
import { request } from '../../lib/desktop';

export function useAgentConfig(open: boolean) {
  const [settings, setSettings] = useState<AgentConfigSettings>();
  const [draft, setDraft] = useState<AgentConfig>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const reload = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const value = await request({ type: 'agentConfig.get' });
      setSettings(value);
      setDraft(structuredClone(value.current.config));
      setNotice('');
    } catch (error) {
      setError(error instanceof Error ? error.message : '无法加载 Agent 配置');
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    if (open) void reload();
  }, [open, reload]);
  const dirty =
    !!settings && !!draft && JSON.stringify(settings.current.config) !== JSON.stringify(draft);
  async function save() {
    if (!settings || !draft || busy) return false;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const value = await request({
        type: 'agentConfig.save',
        config: draft,
        expectedRevision: settings.current.revision!,
      });
      setSettings(value);
      setDraft(structuredClone(value.current.config));
      setNotice('已保存，将用于新会话。');
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : '保存失败');
      return false;
    } finally {
      setBusy(false);
    }
  }
  return {
    settings,
    draft,
    setDraft,
    dirty,
    busy,
    error,
    notice,
    reload,
    save,
    reset: () => {
      if (settings) setDraft(structuredClone(settings.current.config));
      setError('');
      setNotice('');
    },
  };
}
export type AgentConfigController = ReturnType<typeof useAgentConfig>;
