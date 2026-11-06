import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionDetail, SessionRecord } from '../../../shared/models';
import { request } from '../../lib/desktop';

export function useSessions(search: string, archived: boolean, onError: (message: string) => void) {
  const [list, setList] = useState<SessionRecord[]>([]);
  const [selected, setSelected] = useState<string | null>(() => localStorage.getItem('selected-session'));
  const selectedRef = useRef(selected);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const listEpoch = useRef(0), detailEpoch = useRef(0);
  const refresh = useCallback(async () => {
    const epoch = ++listEpoch.current;
    try {
      const value = await request<SessionRecord[]>({ type: 'sessions.list', search, archived });
      if (epoch === listEpoch.current) setList(value);
    } catch (error) { onError(String(error instanceof Error ? error.message : error)); }
  }, [search, archived, onError]);
  const load = useCallback(async (id = selectedRef.current) => {
    const epoch = ++detailEpoch.current;
    if (!id) { setDetail(null); return; }
    try {
      const value = await request<SessionDetail>({ type: 'sessions.open', sessionId: id });
      if (epoch === detailEpoch.current && selectedRef.current === id) setDetail(value);
    } catch (error) { if (epoch === detailEpoch.current) onError(error instanceof Error ? error.message : '无法打开会话'); }
  }, [onError]);
  const select = useCallback((id: string | null) => {
    selectedRef.current = id; setSelected(id); setDetail(null);
    if (id) localStorage.setItem('selected-session', id); else localStorage.removeItem('selected-session');
    void load(id);
  }, [load]);
  useEffect(() => {
    void refresh();
    const unsubscribe = window.dataAgent.subscribe(event => { if (event.type === 'sessions.changed') { void refresh(); void load(); } });
    return () => { unsubscribe(); ++listEpoch.current; };
  }, [refresh, load]);
  useEffect(() => { void load(); }, [load]);
  async function create(chooseWorkspace = false) {
    const value = await request<SessionRecord | null>({ type: 'sessions.create', chooseWorkspace });
    if (value) { select(value.id); await refresh(); }
    return value;
  }
  async function rename(title: string) {
    if (!selected) return;
    await request({ type: 'sessions.rename', sessionId: selected, title }); await load(); await refresh();
  }
  async function archiveCurrent() {
    if (!detail) return;
    await request({ type: 'sessions.archive', sessionId: detail.session.id, archived: !detail.session.archived });
    select(null); await refresh();
  }
  async function pickFiles() {
    const sessionId = selectedRef.current ?? (await create())?.id;
    if (!sessionId) return;
    await request({ type: 'files.pick', sessionId }); await load();
  }
  async function removeFile(fileId: string) {
    if (!selected) return;
    await request({ type: 'files.remove', sessionId: selected, fileId }); await load();
  }
  async function addFiles(files: File[]) {
    const sessionId = selectedRef.current ?? (await create())?.id;
    if (!sessionId) return;
    const result = await window.dataAgent.addFiles(sessionId, files);
    if (!result.ok) throw new Error(result.error.message);
    await load();
  }
  return { list, selected, detail, select, create, rename, archiveCurrent, pickFiles, addFiles, removeFile, refresh, load };
}
