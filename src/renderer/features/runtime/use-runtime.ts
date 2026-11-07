import { useCallback, useEffect, useRef, useState } from 'react';
import { acceptSnapshot, type RuntimeSnapshot } from '../../../shared/runtime';
import { request } from '../../lib/desktop';

export function useRuntime(sessionId: string | null, onError: (message: string) => void) {
  const [snapshot, setSnapshot] = useState<RuntimeSnapshot | null>(null);
  const selected = useRef(sessionId);
  selected.current = sessionId;
  const watermark = useRef<RuntimeSnapshot | null>(null);
  const epoch = useRef(0);
  const refresh = useCallback(async () => {
    if (!sessionId) return;
    const ticket = ++epoch.current;
    const value = await request<RuntimeSnapshot | null>({ type: 'runtime.snapshot', sessionId });
    if (ticket !== epoch.current || selected.current !== sessionId) return;
    const next = value ? acceptSnapshot(watermark.current, value, sessionId, true) : null;
    watermark.current = next;
    setSnapshot(next);
  }, [sessionId]);
  useEffect(() => {
    watermark.current = null;
    setSnapshot(null);
    void refresh().catch((error) => onError(error.message));
    const unsubscribe = window.dataAgent.subscribe((event) => {
      if (event.type !== 'runtime.event' || event.snapshot.sessionId !== sessionId) return;
      const old = watermark.current;
      if (!old || old.hostEpoch !== event.snapshot.hostEpoch) {
        void refresh().catch((error) => onError(error.message));
        return;
      }
      const next = acceptSnapshot(old, event.snapshot, sessionId);
      watermark.current = next;
      setSnapshot(next);
    });
    // Invalidate async request tickets on cleanup; this ref is not a DOM node.
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps -- Async ticket counter, intentionally invalidated at cleanup.
      ++epoch.current;
      unsubscribe();
    };
  }, [sessionId, refresh, onError]);
  return { snapshot: snapshot?.sessionId === sessionId ? snapshot : null, refresh };
}
