import { HtmlReport } from './HtmlReport';
import { useCallback, useEffect, useRef, useState } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import {
  ChevronRight,
  Copy,
  Download,
  FileText,
  Folder,
  FolderOpen,
  Maximize2,
  Minimize2,
  RefreshCw,
  X,
  Code2,
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import { request } from '../../lib/desktop';
import type { WorkspaceEntry, WorkspaceListing, WorkspacePreview } from '../../../shared/workspace';
import { usePanelSize } from '../artifacts/use-panel-size';
import { ZoomImage } from '../artifacts/ZoomImage';
import { SourcePreview } from '../artifacts/SourcePreview';
import { WorkspaceReport } from './WorkspaceReport';

export function WorkspacePanel({
  sessionId,
  hidden,
  close,
}: {
  sessionId: string | null;
  hidden: boolean;
  close: () => void;
}) {
  const size = usePanelSize();
  const [reportRefresh, setReportRefresh] = useState(0);
  const [wide, setWide] = useState(false),
    [tab, setTab] = useState('files');
  const [showHidden, setShowHidden] = useState(false),
    [busy, setBusy] = useState(false);
  const [directories, setDirectories] = useState<
    Record<string, WorkspaceListing & { error?: string }>
  >({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const [selected, setSelected] = useState<WorkspaceEntry>();
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const [preview, setPreview] = useState<WorkspacePreview>();
  const [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [source, setSource] = useState(false);
  const epoch = useRef(0),
    selection = useRef(0);
  const refresh = useCallback(async () => {
    if (!sessionId || hidden) return;
    const ticket = ++epoch.current;
    setBusy(true);
    setError('');
    try {
      const values = await Promise.all(
        ['root', ...expandedRef.current].map(async (id) => {
          try {
            return [
              id,
              await request({
                type: 'workspace.list',
                sessionId,
                directoryId: id === 'root' ? undefined : id,
                showHidden,
              }),
            ] as const;
          } catch (error) {
            if (id === 'root') throw error;
            return [
              id,
              { entries: [], truncated: false, error: (error as Error).message },
            ] as const;
          }
        }),
      );
      if (ticket !== epoch.current) return;
      const next = Object.fromEntries(values);
      setDirectories(next);
      const previous = selectedRef.current;
      let current =
        previous && values.flatMap(([, v]) => v.entries).find((e) => e.id === previous.id);
      if (previous && !current) {
        // Relative links can select a file whose parent is not expanded in the tree.
        current = await request({
          type: 'workspace.resolve',
          sessionId,
          entryId: previous.id,
          href: encodeURIComponent(previous.name),
        });
      }
      if (ticket !== epoch.current) return;
      if (selectedRef.current?.id === previous?.id && current) setSelected(current);
    } catch (error) {
      if (ticket === epoch.current) setError((error as Error).message);
    } finally {
      if (ticket === epoch.current) setBusy(false);
    }
  }, [sessionId, hidden, showHidden]);
  useEffect(() => {
    void refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = '';
    const unsubscribe = window.dataAgent.subscribe((event) => {
      if (hidden || event.type !== 'runtime.event' || event.snapshot.sessionId !== sessionId)
        return;
      const signature = `${event.snapshot.runId}:${event.snapshot.state}:${event.snapshot.tools
        .filter((t) => t.status !== 'running')
        .map((t) => t.id)
        .join(',')}`;
      if (signature === last) return;
      last = signature;
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 300);
    });
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps -- Invalidate outstanding asynchronous directory reads.
      ++epoch.current;
      clearTimeout(timer);
      unsubscribe();
    };
  }, [refresh, sessionId, hidden]);
  useEffect(() => {
    const ticket = ++selection.current;
    if (hidden || !sessionId || !selected) return;
    setError('');
    void request({ type: 'workspace.preview', sessionId, entryId: selected.id })
      .then((value) => {
        if (selection.current === ticket) setPreview(value);
      })
      .catch((error) => {
        if (selection.current === ticket) {
          setPreview(undefined);
          setError(error.message);
        }
      });
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps -- Invalidate outstanding asynchronous preview reads.
      ++selection.current;
    };
  }, [sessionId, selected, hidden, directories]);
  function choose(entry: WorkspaceEntry) {
    if (entry.kind !== 'file') return;
    setSelected(entry);
    setPreview(undefined);
    setSource(false);
    setNotice('');
    setTab('preview');
  }
  async function toggle(entry: WorkspaceEntry) {
    if (!sessionId) return;
    if (expanded.has(entry.id)) {
      setExpanded((current) => {
        const next = new Set(current);
        next.delete(entry.id);
        return next;
      });
      return;
    }
    const ticket = epoch.current;
    try {
      const listing = await request({
        type: 'workspace.list',
        sessionId,
        directoryId: entry.id,
        showHidden,
      });
      if (ticket !== epoch.current) return;
      setDirectories((current) => ({ ...current, [entry.id]: listing }));
      setExpanded((current) => new Set([...current, entry.id]));
    } catch (error) {
      setError((error as Error).message);
    }
  }
  async function action(kind: 'workspace.copy' | 'workspace.saveAs' | 'workspace.reveal') {
    if (!sessionId) return;
    const ticket = epoch.current;
    setError('');
    setNotice('');
    try {
      if (kind === 'workspace.reveal')
        await request({
          type: kind,
          sessionId,
          entryId: tab === 'preview' ? selected?.id : undefined,
        });
      else if (selected) {
        const result = await request({ type: kind, sessionId, entryId: selected.id });
        if (ticket === epoch.current)
          setNotice(kind === 'workspace.copy' ? '已复制当前展示内容' : result ? '文件已另存' : '');
      }
    } catch (error) {
      if (ticket === epoch.current) setError((error as Error).message);
    }
  }
  function directory(id: string, depth = 0) {
    const listing = directories[id];
    if (!listing) return null;
    return (
      <ul className="workspace-tree" aria-label={id === 'root' ? '工作区文件' : '子目录'}>
        {listing.entries.map((entry) => (
          <li key={entry.id}>
            <button
              className="workspace-entry"
              style={{ paddingInlineStart: 12 + depth * 16 }}
              aria-expanded={entry.kind === 'directory' ? expanded.has(entry.id) : undefined}
              disabled={entry.kind === 'unsupported'}
              title={entry.relativePath}
              onClick={() => (entry.kind === 'directory' ? void toggle(entry) : choose(entry))}
            >
              {entry.kind === 'directory' ? (
                <>
                  <ChevronRight
                    size={14}
                    style={{ transform: expanded.has(entry.id) ? 'rotate(90deg)' : undefined }}
                  />
                  <Folder size={16} />
                </>
              ) : (
                <FileText size={16} />
              )}
              <span>{entry.name}</span>
              {entry.kind === 'unsupported' && <small>不支持</small>}
            </button>
            {entry.kind === 'directory' && expanded.has(entry.id) && directory(entry.id, depth + 1)}
          </li>
        ))}
        {listing.truncated && (
          <li className="artifact-notice">仅显示部分条目，请在 Finder 中查看全部内容。</li>
        )}
        {listing.error && (
          <li role="alert" className="artifact-notice">
            {listing.error}
          </li>
        )}
        {!listing.error && !listing.entries.length && (
          <li className="artifact-notice">{id === 'root' ? '工作区暂无文件' : '空目录'}</li>
        )}
      </ul>
    );
  }
  const html = !!selected && /\.html?$/i.test(selected.name);
  return (
    <aside
      ref={size.ref}
      hidden={hidden}
      style={{ width: wide || size.overlay ? undefined : size.width }}
      className={`result-panel${wide ? ' expanded' : ''}${size.overlay ? ' overlay' : ''}`}
      aria-label="工作区"
    >
      {!wide && !size.overlay && <div className="panel-resizer" {...size.separator} />}
      <Tabs.Root value={tab} onValueChange={setTab} className="artifact-tabs-root">
        <div className="result-header">
          <Tabs.List className="tabs" aria-label="工作区视图">
            <Tabs.Trigger value="files">文件</Tabs.Trigger>
            <Tabs.Trigger value="preview">预览</Tabs.Trigger>
          </Tabs.List>
          <span className="composer-spacer" />
          <Button
            size="icon"
            variant="ghost"
            aria-label="刷新工作区"
            disabled={!sessionId || busy}
            onClick={() => void refresh().then(() => setReportRefresh((value) => value + 1))}
          >
            <RefreshCw />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label={tab === 'preview' ? '在 Finder 中定位文件' : '打开工作区'}
            disabled={!sessionId}
            onClick={() => void action('workspace.reveal')}
          >
            <FolderOpen />
          </Button>
          {tab === 'preview' && selected && (
            <>
              {preview?.text !== undefined && (!html || source) && (
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="复制当前内容"
                  onClick={() => void action('workspace.copy')}
                >
                  <Copy />
                </Button>
              )}
              <Button
                size="icon"
                variant="ghost"
                aria-label="另存文件"
                onClick={() => void action('workspace.saveAs')}
              >
                <Download />
              </Button>
            </>
          )}
          <Button
            size="icon"
            variant="ghost"
            aria-label={wide ? '缩小结果面板' : '展开结果面板'}
            onClick={() => setWide(!wide)}
          >
            {wide ? <Minimize2 /> : <Maximize2 />}
          </Button>
          <Button size="icon" variant="ghost" aria-label="关闭结果面板" onClick={close}>
            <X />
          </Button>
        </div>
        {tab === 'files' && sessionId && (
          <label className="workspace-options">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(e) => setShowHidden(e.target.checked)}
            />
            显示隐藏文件
          </label>
        )}
        {tab === 'preview' && selected && (
          <div className="artifact-toolbar">
            <span className="workspace-filename" title={selected.relativePath}>
              {selected.relativePath}
            </span>
            {(html || preview?.entry.name.toLowerCase().endsWith('.md')) && (
              <Button size="sm" variant="ghost" onClick={() => setSource(!source)}>
                <Code2 size={14} />
                {source ? '阅读视图' : '查看源码'}
              </Button>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="artifact-notice">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="artifact-notice">
            {notice}
          </p>
        )}
        <Tabs.Content value="files" className="artifact-scroll" tabIndex={0}>
          {!sessionId ? (
            <p className="artifact-notice">发送第一条消息后创建工作区</p>
          ) : directories.root ? (
            directory('root')
          ) : busy ? (
            <p className="artifact-notice">正在读取工作区…</p>
          ) : null}
        </Tabs.Content>
        <Tabs.Content
          value="preview"
          className="artifact-scroll"
          tabIndex={0}
          style={html && !source ? { display: 'none' } : undefined}
        >
          {!selected ? (
            <p className="artifact-notice">从文件列表选择文件进行预览</p>
          ) : preview ? (
            preview.image ? (
              <ZoomImage src={preview.image} alt={preview.entry.relativePath} />
            ) : preview.text === '' ? (
              <p className="artifact-notice">文件为空</p>
            ) : preview.text !== undefined ? (
              preview.entry.name.toLowerCase().endsWith('.md') && !source ? (
                <WorkspaceReport preview={preview} choose={choose} onError={setError} />
              ) : (
                <SourcePreview preview={preview} />
              )
            ) : (
              <p className="artifact-notice">{preview.notice}</p>
            )
          ) : !error ? (
            <p className="artifact-notice">正在读取文件…</p>
          ) : null}
        </Tabs.Content>
        {html && selected && (
          <HtmlReport
            entry={selected}
            hidden={hidden || tab !== 'preview' || source}
            refresh={reportRefresh}
          />
        )}
      </Tabs.Root>
    </aside>
  );
}
