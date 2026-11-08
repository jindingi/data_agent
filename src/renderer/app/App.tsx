import { SessionAgentConfigDialog } from '../features/agent-config/SessionAgentConfigDialog';
import { SettingsDialog } from '../features/settings/SettingsDialog';
import { RunControls } from '../features/runtime/RunControls';
import { useActivity } from '../features/runtime/use-activity';
import { Composer } from '../features/composer/Composer';
import { useModelSettings } from '../features/models/use-model-settings';
import { useComposer } from '../features/composer/use-composer';
import { SessionSidebar } from '../features/sessions/SessionSidebar';
import { SessionHeader } from '../features/sessions/SessionHeader';
import { useEffect, useRef, useState } from 'react';
import { ChartNoAxesCombined, FileChartColumn, Table2, X } from 'lucide-react';
import { Button } from '../components/ui/button';
import { RenameSessionDialog } from '../features/sessions/RenameSessionDialog';
import { DeleteSessionDialog } from '../features/sessions/DeleteSessionDialog';
import { useSessions } from '../features/sessions/use-sessions';
import { isActive } from '../../shared/runtime';
import { useRuntime } from '../features/runtime/use-runtime';
import { Transcript } from '../features/runtime/Transcript';
import { WorkspacePanel } from '../features/workspace/WorkspacePanel';
import { readTheme, saveTheme } from '../lib/theme';

const ideas = [
  {
    icon: ChartNoAxesCombined,
    title: '看清变化',
    prompt: '分析最近 3 个月各地区的销售变化，找出下降最明显的地区。',
  },
  { icon: Table2, title: '发现联系', prompt: '关联这几份数据，比较不同客户群体的表现。' },
  {
    icon: FileChartColumn,
    title: '整理成报告',
    prompt: '分析这份数据的主要特征，生成图表和一份 Markdown 报告。',
  },
];
export function App() {
  const [theme, setTheme] = useState(readTheme);
  const [error, setError] = useState('');
  const [sidebar, setSidebar] = useState(true);
  const [panel, setPanel] = useState(false);
  const [settings, setSettings] = useState(false);
  const [search, setSearch] = useState('');
  const [archived, setArchived] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [configSession, setConfigSession] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const activity = useActivity(setError);
  const modelSettings = useModelSettings();
  const [dragging, setDragging] = useState(false);
  const sessions = useSessions(search, archived, setError);
  const selection = useRef(sessions.selected);
  useEffect(() => {
    selection.current = sessions.selected;
  }, [sessions.selected]);
  const composer = useComposer(
    sessions.selected,
    (id, origin) => {
      if (selection.current === origin) sessions.select(id);
      void sessions.refresh();
    },
    setError,
  );
  const draft = composer.draft.text;
  const setDraft = composer.setText;
  const current = sessions.detail?.session;
  const runtime = useRuntime(current?.id ?? null, setError);
  const active = runtime.snapshot ? isActive(runtime.snapshot.state) : false;
  const canSend =
    Boolean(draft.trim()) &&
    !composer.sending &&
    !modelSettings.busy &&
    !current?.error &&
    (!active ||
      ['running', 'waiting_approval', 'waiting_input'].includes(runtime.snapshot?.state ?? ''));
  const history = runtime.snapshot?.messages ?? sessions.detail?.messages ?? [];
  const act = (task: Promise<unknown>) => {
    void task.catch((error) => setError(error instanceof Error ? error.message : '操作失败'));
  };
  async function newSession() {
    sessions.select(null);
    setArchived(false);
    setSearch('');
    setPanel(false);
  }
  async function send(kind: 'prompt' | 'steer' | 'followUp') {
    if (!canSend) return;
    setError('');
    await composer.send(kind);
  }
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!event.metaKey) return;
      if (event.key === ',') {
        event.preventDefault();
        setSettings(true);
      }
      if (event.key.toLowerCase() === 'n') {
        event.preventDefault();
        act(newSession());
        document.querySelector<HTMLTextAreaElement>('textarea[aria-label="分析需求"]')?.focus();
      }
      if (event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setSidebar(true);
        requestAnimationFrame(() =>
          document.querySelector<HTMLInputElement>('input[aria-label="搜索会话"]')?.focus(),
        );
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  });
  return (
    <div className="desktop-shell">
      <div className={`app-layout${sidebar ? '' : ' sidebar-hidden'}`}>
        {sidebar && (
          <SessionSidebar
            sessions={sessions}
            search={search}
            setSearch={setSearch}
            archived={archived}
            setArchived={setArchived}
            activity={activity}
            onNew={() => act(newSession())}
            onSettings={() => setSettings(true)}
          />
        )}
        <main
          className={`main-area${dragging ? ' drag-over' : ''}`}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes('Files')) {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'copy';
              setDragging(true);
            }
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null))
              setDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const incoming = Array.from(event.dataTransfer.files);
            if (incoming.length) act(composer.dropFiles(incoming));
          }}
        >
          {dragging && <div className="drop-hint">松开以添加 CSV 原文件路径</div>}
          <SessionHeader
            current={current}
            sidebar={sidebar}
            setSidebar={setSidebar}
            panel={panel}
            setPanel={setPanel}
            theme={theme}
            onTheme={(value) => {
              saveTheme(value);
              setTheme(value);
            }}
            onRename={() => {
              setRenaming(true);
            }}
            onArchive={() => act(sessions.archiveCurrent())}
            onDelete={() => setDeleting(current!.id)}
            onAgentConfig={() => setConfigSession(current!.id)}
          />
          {error && (
            <div role="alert" className="error-banner">
              {error}
              <Button
                size="icon"
                variant="ghost"
                aria-label="关闭错误"
                onClick={() => setError('')}
              >
                <X size={16} />
              </Button>
            </div>
          )}
          {current?.error && (
            <div role="alert" className="error-banner">
              {current.error}
            </div>
          )}
          <section className={`welcome ${history.length ? 'has-history' : ''}`}>
            {history.length ? (
              <Transcript
                key={sessions.selected}
                messages={history}
                tools={runtime.snapshot?.tools ?? []}
                turnUsage={runtime.snapshot?.turnUsage ?? []}
                active={
                  !!runtime.snapshot &&
                  !runtime.snapshot.queuedInputs?.some((input) => input.kind === 'prompt') &&
                  ['running', 'waiting_approval', 'waiting_input'].includes(runtime.snapshot.state)
                }
              />
            ) : (
              <>
                <div className="welcome-icon">
                  <ChartNoAxesCombined size={28} strokeWidth={1.5} />
                </div>
                <h1>让数据，回答你的问题。</h1>
                <p className="welcome-copy">
                  带上你的数据，说说你想了解什么。
                  <br />让 AI 协助探索、绘图，把发现整理成报告。
                </p>
              </>
            )}
            <div className="composer-wrap">
              <RunControls
                snapshot={runtime.snapshot}
                restore={composer.restore}
                refresh={runtime.refresh}
                onError={setError}
              />
              <Composer
                composer={composer}
                modelSettings={modelSettings}
                hasSession={Boolean(current)}
                active={active}
                canSend={canSend}
                onSend={send}
                openSettings={() => setSettings(true)}
                onError={setError}
              />
            </div>
            {history.length === 0 && (
              <div className="idea-grid">
                {ideas.map(({ icon: Icon, title, prompt }) => (
                  <button className="idea-card" key={title} onClick={() => setDraft(prompt)}>
                    <div>
                      <Icon size={17} />
                      <strong>{title}</strong>
                    </div>
                    <p>{prompt}</p>
                  </button>
                ))}
              </div>
            )}
          </section>
        </main>
        <WorkspacePanel
          key={sessions.selected ?? 'home'}
          hidden={!panel}
          sessionId={current?.id ?? null}
          close={() => {
            setPanel(false);
            requestAnimationFrame(() =>
              document
                .querySelector<HTMLButtonElement>('button[aria-label="切换结果面板"]')
                ?.focus(),
            );
          }}
        />
      </div>
      {deleting && (
        <DeleteSessionDialog
          key={deleting}
          sessionId={deleting}
          close={() => setDeleting(null)}
          deleted={() => {
            composer.forget(deleting);
            sessions.select(null);
            setDeleting(null);
            setError('');
            void sessions.refresh();
          }}
        />
      )}
      {renaming && current && (
        <RenameSessionDialog
          initialTitle={current.title}
          rename={sessions.rename}
          close={() => setRenaming(false)}
        />
      )}
      {configSession && (
        <SessionAgentConfigDialog
          sessionId={configSession}
          close={() => setConfigSession(null)}
          newConversation={() => sessions.select(null)}
        />
      )}
      <SettingsDialog open={settings} onOpenChange={setSettings} modelSettings={modelSettings} />
    </div>
  );
}
