import { useCallback, useEffect, useState } from 'react';
import type { ExampleStatus } from '../../../shared/examples';
import { request } from '../../lib/desktop';

export function useExamples() {
  const [value, setValue] = useState<ExampleStatus>({ sessions: [] });
  const load = useCallback(async () => {
    try {
      setValue(await request({ type: 'examples.status' }));
    } catch (error) {
      setValue({ sessions: [], error: (error as Error).message });
    }
  }, []);
  useEffect(() => {
    void load();
    return window.dataAgent.subscribe((event) => {
      if (event.type === 'sessions.changed') void load();
    });
  }, [load]);
  const retry = async () => {
    setValue(await request({ type: 'examples.install' }));
  };
  return { ...value, retry };
}
