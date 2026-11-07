import { useState, useEffect } from 'react';
import type { RuntimeSnapshot } from '../../../shared/runtime';
import { request } from '../../lib/desktop';
export function useActivity(onError: (message: string) => void) {
  const [activity, setActivity] = useState<Record<string, RuntimeSnapshot['state']>>({});
  useEffect(() => {
    let mounted = true;
    const recentActivity: Record<string, RuntimeSnapshot['state']> = {};
    const unsubscribe = window.dataAgent.subscribe((event) => {
      if (event.type === 'runtime.event') {
        const { sessionId, state } = event.snapshot;
        recentActivity[sessionId] = state;
        setActivity((previous) =>
          previous[sessionId] === state ? previous : { ...previous, [sessionId]: state },
        );
      }
    });
    void request({ type: 'runtime.activeStates' })
      .then((value) => {
        if (mounted) setActivity({ ...value, ...recentActivity });
      })
      .catch((error) => {
        if (mounted) onError(error.message);
      });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [onError]);
  return activity;
}
