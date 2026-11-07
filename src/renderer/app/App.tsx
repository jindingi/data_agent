import { SessionSidebar } from '../features/sessions/SessionSidebar';
import { SessionHeader } from '../features/sessions/SessionHeader';
import { useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowUp,
  ChartNoAxesCombined,
  ChevronDown,
  FileChartColumn,
  FolderOpen,
  Plus,
  ShieldCheck,
  Sparkles,
  Table2,
  X,
} from 'lucide-react';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../components/ui/dialog';
import { DeleteSessionDialog } from '../features/sessions/DeleteSessionDialog';
import { useSessions } from '../features/sessions/use-sessions';
import type { SystemInfo } from '../../shared/contracts/ipc';
import {
  isActive,
  type ModelSettings as ModelConfiguration,
  type RunInput,
  type ThinkingLevel,
  type RuntimeSnapshot,
} from '../../shared/runtime';
import { useRuntime } from '../features/runtime/use-runtime';
import { Transcript } from '../features/runtime/Transcript';
import { ModelSettings } from '../features/runtime/ModelSettings';
import { ArtifactPanel } from '../features/artifacts/ArtifactPanel';
import { InteractionCard } from '../features/runtime/InteractionCard';
import { request } from '../lib/desktop';
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
  const sendPending = useRef(false);
  const composing = useRef(false);
  const [info, setInfo] = useState<SystemInfo>();
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sidebar, setSidebar] = useState(true);
  const [panel, setPanel] = useState(false);
  const [settings, setSettings] = useState(false);
  const [ping, setPing] = useState('');
  const [search, setSearch] = useState('');
  const [archived, setArchived] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [activity, setActivity] = useState<Record<string, RuntimeSnapshot['state']>>({});
  const [models, setModels] = useState<ModelConfiguration>();
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [modelBusy, setModelBusy] = useState(false);
  const selectedModel = models?.models.find(
    (model) => model.provider === models.selected.provider && model.model === models.selected.model,
  );
  const thinkingLabels: Record<ThinkingLevel, string> = {
    off: '关闭思考',
    minimal: '最少思考',
    low: '低思考',
    medium: '中思考',
    high: '高思考',
    xhigh: '更高思考',
    max: '最高思考',
  };
  const [inputKind, setInputKind] = useState<'steer' | 'followUp'>('steer');
  const sessions = useSessions(search, archived, setError);
  const draftKey = sessions.selected ?? 'new';
  const draft = drafts[draftKey] ?? '';
  const setDraft = (value: string) => setDrafts((previous) => ({ ...previous, [draftKey]: value }));
  const runtime = useRuntime(sessions.selected, setError);
  const active = runtime.snapshot ? isActive(runtime.snapshot.state) : false;
  const current = sessions.detail?.session;
  const canSend =
    Boolean(draft.trim()) &&
    !sending &&
    !modelBusy &&
    !current?.error &&
    (!active ||
      ['running', 'waiting_approval', 'waiting_input'].includes(runtime.snapshot?.state ?? ''));
  const files = sessions.detail?.files ?? [];
  const history = runtime.snapshot?.messages ?? sessions.detail?.messages ?? [];
  const act = (task: Promise<unknown>) => {
    void task.catch((error) => setError(error instanceof Error ? error.message : '操作失败'));
  };
  async function newSession(chooseWorkspace = false) {
    const value = await sessions.create(chooseWorkspace);
    if (value) {
      setArchived(false);
      setSearch('');
    }
  }
  async function send() {
    if (!canSend || sendPending.current) return;
    sendPending.current = true;
    setSending(true);
    setError('');
    try {
      const id = sessions.selected ?? (await sessions.create())?.id;
      if (!id) return;
      const input: RunInput = {
        inputId: crypto.randomUUID(),
        kind: active ? inputKind : 'prompt',
        text: draft,
      };
      await request({ type: 'runtime.submit', sessionId: id, input });
      setDraft('');
      await runtime.refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : '无法发送');
    } finally {
      sendPending.current = false;
      setSending(false);
    }
  }
  useEffect(() => {
    let mounted = true;
    const refresh = () =>
      window.dataAgent
        .request({ type: 'system.info' })
        .then((r) => {
          if (!mounted) return;
          if (r.ok) setInfo(r.value as SystemInfo);
          else setError(r.error.message);
        })
        .catch(() => {
          if (mounted) setError('无法连接桌面服务，请重新打开应用。');
        });
    void refresh();
    void request({ type: 'models.settings' })
      .then((value) => {
        if (mounted) setModels(value);
      })
      .catch((error) => {
        if (mounted) setError(error.message);
      });
    const recentActivity: Record<string, RuntimeSnapshot['state']> = {};
    const unsubscribe = window.dataAgent.subscribe((event) => {
      if (event.type === 'host.status') void refresh();
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
        if (mounted) setError(error.message);
      });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);
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
  async function checkConnection() {
    setPing('正在检查…');
    const r = await window.dataAgent.request({ type: 'system.ping', text: 'desktop-health' });
    setPing(r.ok ? '连接正常' : r.error.message);
  }
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
            if (incoming.length) act(sessions.addFiles(incoming));
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
              setTitle(current!.title);
              setRenaming(true);
            }}
            onArchive={() => act(sessions.archiveCurrent())}
            onDelete={() => setDeleting(current!.id)}
          />
          {error && (
            <div role="alert" className="error-banner">
              {error}
              <button aria-label="关闭错误" onClick={() => setError('')}>
                <X size={16} />
              </button>
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
                sessionId={sessions.selected!}
                messages={history}
                tools={runtime.snapshot?.tools ?? []}
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
              {runtime.snapshot?.interactions?.map((interaction) => (
                <InteractionCard key={interaction.id} value={interaction} onError={setError} />
              ))}
              {(runtime.snapshot?.queuedInputs ?? [])
                .filter(
                  (input) =>
                    input.kind !== 'prompt' ||
                    !active ||
                    runtime.snapshot?.state === 'queued' ||
                    runtime.snapshot?.state === 'starting',
                )
                .map((input) => (
                  <div className="queued-input" key={input.inputId}>
                    <span>
                      {active ? '等待处理' : '未发送'} ·{' '}
                      {input.kind === 'steer'
                        ? '插话'
                        : input.kind === 'followUp'
                          ? '后续提问'
                          : '提问'}
                    </span>
                    <p>{input.text}</p>
                    {!active && <button onClick={() => setDraft(input.text)}>放回输入框</button>}
                  </div>
                ))}
              {(runtime.snapshot?.unsentInputs ?? []).map((input) => (
                <div className="queued-input" data-unsent-input={input.inputId} key={input.inputId}>
                  <span>
                    未发送 ·{' '}
                    {input.kind === 'steer'
                      ? '插话'
                      : input.kind === 'followUp'
                        ? '后续提问'
                        : '提问'}
                  </span>
                  <p>{input.text}</p>
                  <button onClick={() => setDraft(input.text)}>放回输入框</button>
                  <button
                    onClick={() =>
                      act(
                        request({
                          type: 'runtime.discardDraft',
                          sessionId: sessions.selected!,
                          inputId: input.inputId,
                        }).then(() => runtime.refresh()),
                      )
                    }
                  >
                    移除未发送输入
                  </button>
                </div>
              ))}
              {runtime.snapshot && (
                <div className="run-status" role="status" data-run-state={runtime.snapshot.state}>
                  <span>
                    {
                      {
                        queued: '等待运行名额',
                        starting: '正在连接模型',
                        running: 'Agent 正在执行',
                        waiting_approval: '等待你批准操作',
                        waiting_input: '等待你补充信息',
                        completed: '执行完成',
                        cancelled: '已停止',
                        failed: '本轮执行出错',
                        interrupted: '上次执行已中断',
                      }[runtime.snapshot.state]
                    }
                  </span>
                  {runtime.snapshot.activity && (
                    <small data-runtime-activity={runtime.snapshot.activity.kind}>
                      {runtime.snapshot.activity.kind === 'retry'
                        ? `模型请求重试中（${runtime.snapshot.activity.attempt}/${runtime.snapshot.activity.maxAttempts}）`
                        : '正在压缩上下文，完整历史仍保留'}
                    </small>
                  )}
                  {runtime.snapshot.inputs.filter(
                    (input) => input.state === 'pending' && input.kind !== 'prompt',
                  ).length > 0 && <small>有待处理输入</small>}
                  {active && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        act(request({ type: 'runtime.cancel', sessionId: sessions.selected! }))
                      }
                    >
                      停止
                    </Button>
                  )}
                  {runtime.snapshot.error && <span role="alert">{runtime.snapshot.error}</span>}
                </div>
              )}
              <div className="workspace-hint">
                <FolderOpen size={15} />
                <span title={current?.workspace ?? info?.workspaceRoot}>
                  {current ? current.workspace.split('/').slice(-2).join('/') : '会话独立工作区'}
                </span>
                <button
                  aria-label="选择新会话工作区"
                  title="在指定位置新建会话"
                  onClick={() => act(newSession(true))}
                >
                  <ChevronDown size={12} />
                </button>
                <span className="hint-separator" />
                <ShieldCheck size={13} />
                <span>外部写入需审批</span>
              </div>
              <div className="composer">
                {files.length > 0 && (
                  <div className="attachment-list">
                    {files.map((file) => (
                      <span key={file.id} title={file.path}>
                        <Table2 size={13} />
                        <span>
                          {file.name}
                          {file.missing ? ' · 文件缺失' : ''}
                        </span>
                        <button
                          aria-label={`移除文件 ${file.name}`}
                          onClick={() => act(sessions.removeFile(file.id))}
                        >
                          <X size={12} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <textarea
                  aria-label="分析需求"
                  placeholder="描述你的分析需求，或先添加 CSV 文件…"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onCompositionStart={() => {
                    composing.current = true;
                  }}
                  onCompositionEnd={() => {
                    composing.current = false;
                  }}
                  onKeyDown={(event) => {
                    if (
                      event.key !== 'Enter' ||
                      event.shiftKey ||
                      composing.current ||
                      event.nativeEvent.isComposing ||
                      event.nativeEvent.keyCode === 229
                    )
                      return;
                    event.preventDefault();
                    if (!event.repeat) void send();
                  }}
                  rows={4}
                />
                <div className="composer-bottom">
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="添加 CSV 文件"
                    onClick={() => act(sessions.pickFiles())}
                  >
                    <Plus />
                  </Button>
                  <span className="attachment-hint">CSV · 多文件</span>
                  <div className="composer-spacer" />
                  {active && (
                    <select
                      className="input-kind"
                      aria-label="运行中输入方式"
                      value={inputKind}
                      onChange={(event) => setInputKind(event.target.value as 'steer' | 'followUp')}
                    >
                      <option value="steer">插话</option>
                      <option value="followUp">后续提问</option>
                    </select>
                  )}
                  {selectedModel?.reasoning && selectedModel.thinkingLevels.length > 1 && (
                    <select
                      className="composer-thinking"
                      aria-label="输入区思考级别"
                      title="用于之后提交的任务"
                      value={models?.thinkingLevel}
                      disabled={modelBusy}
                      onChange={(event) => {
                        const level = event.target.value as ThinkingLevel;
                        setModelBusy(true);
                        act(
                          request({ type: 'models.thinking', level })
                            .then(setModels)
                            .finally(() => setModelBusy(false)),
                        );
                      }}
                    >
                      {selectedModel.thinkingLevels.map((level) => (
                        <option key={level} value={level}>
                          {thinkingLabels[level]}
                        </option>
                      ))}
                    </select>
                  )}
                  <button className="model-button" onClick={() => setSettings(true)}>
                    <Sparkles size={14} />
                    {models?.configuredProviders.includes(models.selected.provider)
                      ? (models.models.find(
                          (model) =>
                            model.provider === models.selected.provider &&
                            model.model === models.selected.model,
                        )?.name ?? models.selected.model)
                      : '配置模型'}
                    <ChevronDown size={13} />
                  </button>
                  <Button
                    size="icon"
                    aria-label="发送分析需求"
                    disabled={!canSend}
                    onClick={() => void send()}
                    title="Enter 发送 · Shift+Enter 换行"
                  >
                    <ArrowUp />
                  </Button>
                </div>
              </div>
              <div className="composer-caption">
                <span className="keyboard-hint">Enter 发送 · Shift+Enter 换行</span>
              </div>
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
        <ArtifactPanel
          key={sessions.selected ?? 'home'}
          hidden={!panel}
          sessionId={sessions.selected}
          inputs={files}
          close={() => {
            setPanel(false);
            requestAnimationFrame(() =>
              document
                .querySelector<HTMLButtonElement>('button[aria-label="切换结果面板"]')
                ?.focus(),
            );
          }}
          onError={setError}
        />
      </div>
      {deleting && (
        <DeleteSessionDialog
          key={deleting}
          sessionId={deleting}
          close={() => setDeleting(null)}
          deleted={() => {
            sessions.select(null);
            setDeleting(null);
            setError('');
            void sessions.refresh();
          }}
        />
      )}
      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent>
          <DialogTitle className="text-lg font-semibold">重命名会话</DialogTitle>
          <DialogDescription className="mt-2 text-sm text-muted-foreground">
            为这个分析起一个容易找到的名字。
          </DialogDescription>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              act(sessions.rename(title).then(() => setRenaming(false)));
            }}
          >
            <input
              className="rename-input"
              aria-label="会话标题"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={120}
              required
            />
            <Button type="submit">保存名称</Button>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog open={settings} onOpenChange={setSettings}>
        <DialogContent>
          <DialogTitle className="text-xl font-semibold">设置</DialogTitle>
          <DialogDescription className="mt-2 text-sm text-muted-foreground">
            管理模型与本地工作环境
          </DialogDescription>
          <ModelSettings value={models} onChange={setModels} onError={setError} />
          <div className="settings-section">
            <h3>
              <FolderOpen size={15} />
              本地工作区
            </h3>
            <p className="path-label">{info?.workspaceRoot ?? '正在加载…'}</p>
            <p>每个会话使用独立目录，原始 CSV 不会被复制或移动。</p>
          </div>
          <details className="diagnostics">
            <summary>
              <Activity size={15} />
              应用诊断
            </summary>
            <dl>
              <dt>版本</dt>
              <dd>{info?.version}</dd>
              <dt>平台</dt>
              <dd>
                {info?.platform} / {info?.architecture}
              </dd>
              <dt>本地存储</dt>
              <dd>{info?.sqliteVersion ? 'SQLite 已连接' : '连接中'}</dd>
            </dl>
            <Button size="sm" variant="outline" onClick={() => void checkConnection()}>
              检查连接
            </Button>
            <span role="status" className="ping-result">
              {ping}
            </span>
          </details>
        </DialogContent>
      </Dialog>
    </div>
  );
}
