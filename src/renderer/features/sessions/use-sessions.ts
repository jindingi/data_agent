import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionDetail, SessionRecord } from '../../../shared/models';
import { AppError } from '../../../shared/errors';
import { request } from '../../lib/desktop';

export function useSessions(search: string, archived: boolean, onError: (message: string) => void) {
  const [list, setList] = useState<SessionRecord[]>([]);
  const [selected, setSelected] = useState<string | null>(() =>
    localStorage.getItem('selected-session'),
  );
  const selectedRef = useRef(selected);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const listEpoch = useRef(0),
    detailEpoch = useRef(0);
  const refresh = useCallback(async () => {
    const epoch = ++listEpoch.current;
    try {
      const value = await request({ type: 'sessions.list', search, archived });
      if (epoch === listEpoch.current) setList(value);
    } catch (error) {
      onError(String(error instanceof Error ? error.message : error));
    }
  }, [search, archived, onError]);
  const load = useCallback(
    async (id = selectedRef.current) => {
      const epoch = ++detailEpoch.current;
      if (!id) {
        setDetail(null);
        return;
      }
      try {
        const value = await request({ type: 'sessions.open', sessionId: id });
        if (epoch === detailEpoch.current && selectedRef.current === id) setDetail(value);
      } catch (error) {
        if (epoch !== detailEpoch.current || selectedRef.current !== id) return;
        if (error instanceof AppError && error.code === 'SESSION_NOT_FOUND') {
          selectedRef.current = null;
          setSelected(null);
          setDetail(null);
          localStorage.removeItem('selected-session');
          return;
        }
        onError(error instanceof Error ? error.message : '无法打开会话');
      }
    },
    [onError],
  );
  const select = useCallback(
    (id: string | null) => {
      selectedRef.current = id;
      setSelected(id);
      setDetail(null);
      if (id) localStorage.setItem('selected-session', id);
      else localStorage.removeItem('selected-session');
      void load(id);
    },
    [load],
  );
  useEffect(() => {
    void refresh();
    const unsubscribe = window.dataAgent.subscribe((event) => {
      if (event.type === 'sessions.changed') {
        void refresh();
        void load();
      }
    });
    // Invalidate async request tickets on cleanup; this ref is not a DOM node.
    return () => {
      unsubscribe();
      // eslint-disable-next-line react-hooks/exhaustive-deps -- Async ticket counter, intentionally invalidated at cleanup.
      ++listEpoch.current;
    };
  }, [refresh, load]);
  useEffect(() => {
    void load();
  }, [load]);
  async function rename(title: string) {
    if (!selected) return;
    await request({ type: 'sessions.rename', sessionId: selected, title });
    await load();
    await refresh();
  }
  async function archiveCurrent() {
    if (!detail) return;
    await request({
      type: 'sessions.archive',
      sessionId: detail.session.id,
      archived: !detail.session.archived,
    });
    select(null);
    await refresh();
  }
  return {
    list,
    selected,
    detail,
    select,
    rename,
    archiveCurrent,
    refresh,
    load,
  };
}
