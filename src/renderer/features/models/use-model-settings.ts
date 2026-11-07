import { useCallback, useEffect, useRef, useState } from 'react';
import type { ModelSettings } from '../../../shared/runtime';
import type { CommandInput } from '../../../shared/contracts/ipc';
import { request } from '../../lib/desktop';
type Change = Extract<
  CommandInput,
  { type: 'models.select' | 'models.thinking' | 'models.key' | 'models.connection' }
>;
/** One owner for both the composer and settings dialog; changes are serialized. */
export function useModelSettings() {
  const [value, setValue] = useState<ModelSettings>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const locked = useRef(false),
    ticket = useRef(0);
  const reload = useCallback(async () => {
    if (locked.current) return;
    const current = ++ticket.current;
    setError('');
    setBusy(true);
    try {
      const result = await request({ type: 'models.settings' });
      if (ticket.current === current) setValue(result);
    } catch (error) {
      if (ticket.current === current)
        setError(error instanceof Error ? error.message : '读取模型设置失败');
    } finally {
      if (ticket.current === current) setBusy(false);
    }
  }, []);
  useEffect(() => {
    void reload();
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps -- Invalidate async request tickets, not a DOM ref.
      ++ticket.current;
    };
  }, [reload]);
  const change = useCallback(async (command: Change) => {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError('');
    const current = ++ticket.current;
    try {
      const result = await request(command);
      if (current === ticket.current) setValue(result);
      return result;
    } catch (error) {
      if (current === ticket.current)
        setError(error instanceof Error ? error.message : '模型配置失败');
    } finally {
      locked.current = false;
      if (current === ticket.current) setBusy(false);
    }
  }, []);
  return { value, busy, error, change, reload };
}
export type ModelController = ReturnType<typeof useModelSettings>;
