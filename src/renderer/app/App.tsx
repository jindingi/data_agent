import { useEffect, useState } from 'react';
import { Activity, Archive, ArchiveRestore, Pencil, ArrowUp, ChartNoAxesCombined, ChevronDown, FileChartColumn, FileText, FolderOpen, Layers3, PanelLeftClose, PanelLeftOpen, PanelRight, Plus, Search, Settings2, ShieldCheck, Sparkles, Table2, X } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../components/ui/dialog';
import { useSessions } from '../features/sessions/use-sessions';
import type { SystemInfo } from '../../shared/contracts/ipc';
import { isActive, type ModelSettings as ModelConfiguration, type RunInput } from '../../shared/runtime';
import { useRuntime } from '../features/runtime/use-runtime';
import { Transcript } from '../features/runtime/Transcript';
import { ModelSettings } from '../features/runtime/ModelSettings';
import { request } from '../lib/desktop';

const ideas = [
  { icon: ChartNoAxesCombined, title: '看清变化', prompt: '分析最近 3 个月各地区的销售变化，找出下降最明显的地区。' },
  { icon: Table2, title: '发现联系', prompt: '关联这几份数据，比较不同客户群体的表现。' },
  { icon: FileChartColumn, title: '整理成报告', prompt: '分析这份数据的主要特征，生成图表和一份 Markdown 报告。' },
];
export function App() {
  const [info, setInfo] = useState<SystemInfo>();
  const [error, setError] = useState('');
  const [draft, setDraft] = useState('');
  const [sidebar, setSidebar] = useState(true);
  const [panel, setPanel] = useState(false);
  const [tab, setTab] = useState<'files' | 'reports'>('files');
  const [settings, setSettings] = useState(false);
  const [ping, setPing] = useState('');
  const [search, setSearch] = useState('');
  const [archived, setArchived] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState('');
  const [models, setModels] = useState<ModelConfiguration>();
  const [sending, setSending] = useState(false);
  const [inputKind, setInputKind] = useState<'steer' | 'followUp'>('steer');
  const sessions = useSessions(search, archived, setError);
  const runtime = useRuntime(sessions.selected, setError);
  const active = runtime.snapshot ? isActive(runtime.snapshot.state) : false;
  const current = sessions.detail?.session;
  const files = sessions.detail?.files ?? [];
  const history = runtime.snapshot?.messages ?? sessions.detail?.messages ?? [];
  const act = (task: Promise<unknown>) => { void task.catch(error => setError(error instanceof Error ? error.message : '操作失败')); };
  async function newSession(chooseWorkspace = false) {
    const value = await sessions.create(chooseWorkspace);
    if (value) { setArchived(false); setSearch(''); setDraft(''); }
  }
  async function send() {
    if (!draft.trim() || sending) return;
    setSending(true); setError('');
    try {
      const id = sessions.selected ?? (await sessions.create())?.id;
      if (!id) return;
      const input: RunInput = { inputId: crypto.randomUUID(), kind: active ? inputKind : 'prompt', text: draft };
      await request({ type: 'runtime.submit', sessionId: id, input });
      setDraft(''); await runtime.refresh();
    } catch (error) { setError(error instanceof Error ? error.message : '无法发送'); } finally { setSending(false); }
  }
  useEffect(() => {
    let mounted = true;
    const refresh = () => window.dataAgent.request({ type: 'system.info' }).then((r) => {
      if (!mounted) return;
      if (r.ok) setInfo(r.value as SystemInfo); else setError(r.error.message);
    }).catch(() => { if (mounted) setError('无法连接桌面服务，请重新打开应用。'); });
    void refresh();
    void request<ModelConfiguration>({ type: 'models.settings' }).then(value => { if (mounted) setModels(value); }).catch(error => { if (mounted) setError(error.message); });
    const unsubscribe = window.dataAgent.subscribe(event => { if (event.type === 'host.status') void refresh(); });
    return () => { mounted = false; unsubscribe(); };
  }, []);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!event.metaKey) return;
      if (event.key === ',') { event.preventDefault(); setSettings(true); }
      if (event.key.toLowerCase() === 'n') { event.preventDefault(); act(newSession()); document.querySelector<HTMLTextAreaElement>('textarea[aria-label="分析需求"]')?.focus(); }
      if (event.key.toLowerCase() === 'k') {
        event.preventDefault(); setSidebar(true);
        requestAnimationFrame(() => document.querySelector<HTMLInputElement>('input[aria-label="搜索会话"]')?.focus());
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
  return <div className="desktop-shell">
    <div className="titlebar"><span>Data Agent</span></div>
    <div className="app-layout">
      {sidebar && <aside className="sidebar" aria-label="会话侧栏">
        <div className="brand"><div className="brand-mark"><ChartNoAxesCombined size={19} strokeWidth={2.2} /></div><span>Data Agent</span><span className="beta">LOCAL</span></div>
        <Button variant="secondary" className="new-chat" aria-label="新会话" onClick={() => act(newSession())}><Plus size={17} />新会话<span>⌘ N</span></Button>
        <label className="search"><Search size={15} /><input aria-label="搜索会话" placeholder="搜索会话" value={search} onChange={(e) => setSearch(e.target.value)} /><kbd>⌘ K</kbd></label>
        <div className="section-label"><button onClick={() => setArchived(!archived)} aria-label={archived ? '查看活跃会话' : '查看归档会话'}>{archived ? '已归档' : '工作空间'} <ChevronDown size={11} /></button><span>{sessions.list.length}</span></div>
        {sessions.list.length > 0 ? <div className="session-list">{sessions.list.map(session => <button key={session.id} aria-label={`打开会话 ${session.title}`} aria-current={sessions.selected === session.id ? 'true' : undefined} onClick={() => sessions.select(session.id)}><FolderOpen size={15} /><span>{session.title}</span><small>{new Date(session.updatedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}</small></button>)}</div> : <div className="session-empty"><Layers3 size={22} strokeWidth={1.3} /><p>{search ? '没有匹配的会话' : '从一个问题开始'}</p><small>你的分析与发现，将留在这里</small></div>}
        <div className="sidebar-bottom"><div className="local-badge"><span className={info?.hostStatus === 'ready' ? 'status-dot' : 'status-dot muted'} /><span data-testid="host-status">{info?.hostStatus === 'ready' ? '本地工作台已就绪' : info?.hostStatus === 'exited' ? 'Agent 连接已断开' : '正在启动工作台'}</span></div><Button variant="ghost" className="settings-button" aria-label="设置" onClick={() => setSettings(true)}><Settings2 />设置<span>⌘ ,</span></Button></div>
      </aside>}
      <main className="main-area">
        <header className="workspace-header"><Button size="icon" variant="ghost" aria-label={sidebar ? '收起侧栏' : '展开侧栏'} onClick={() => setSidebar(!sidebar)}>{sidebar ? <PanelLeftClose /> : <PanelLeftOpen />}</Button><span className="breadcrumb" data-testid="session-title" data-session-id={current?.id}>工作台<span>/</span><strong>{current?.title ?? '新会话'}</strong></span><div className="header-actions">{current && <><Button size="icon" variant="ghost" aria-label="重命名会话" onClick={() => { setTitle(current.title); setRenaming(true); }}><Pencil /></Button><Button size="icon" variant="ghost" aria-label={current.archived ? '恢复会话' : '归档会话'} onClick={() => act(sessions.archiveCurrent())}>{current.archived ? <ArchiveRestore /> : <Archive />}</Button></>}<span className="privacy-label"><ShieldCheck size={14} />文件保留在本地</span><Button size="icon" variant="ghost" aria-label="切换结果面板" aria-pressed={panel} onClick={() => setPanel(!panel)}><PanelRight /></Button></div></header>
        {error && <div role="alert" className="error-banner">{error}<button aria-label="关闭错误" onClick={() => setError('')}><X size={16} /></button></div>}
        {current?.error && <div role="alert" className="error-banner">{current.error}</div>}
        <section className={`welcome ${history.length ? 'has-history' : ''}`}>
          {history.length ? <Transcript messages={history} tools={runtime.snapshot?.tools ?? []} /> : <><div className="welcome-icon"><ChartNoAxesCombined size={28} strokeWidth={1.5} /></div>
          <div className="eyebrow">FROM DATA TO UNDERSTANDING</div>
          <h1>让数据，回答你的问题。</h1>
          <p className="welcome-copy">带上你的数据，说说你想了解什么。<br />让 AI 协助探索、绘图，把发现整理成报告。</p></>}
          <div className="composer-wrap">
            {(runtime.snapshot?.queuedInputs ?? []).filter(input => input.kind !== 'prompt' || !active || runtime.snapshot?.state === 'queued' || runtime.snapshot?.state === 'starting').map(input => <div className="queued-input" key={input.inputId}><span>{active ? '等待处理' : '未发送'} · {input.kind === 'steer' ? '插话' : input.kind === 'followUp' ? '后续提问' : '提问'}</span><p>{input.text}</p>{!active && <button onClick={() => setDraft(input.text)}>放回输入框</button>}</div>)}
            {runtime.snapshot && <div className="run-status" role="status" data-run-state={runtime.snapshot.state}><span>{({ queued: '等待运行名额', starting: '正在连接模型', running: 'Agent 正在执行', completed: '本轮已结束', cancelled: '已停止', failed: '本轮执行出错' })[runtime.snapshot.state]}</span>{runtime.snapshot.inputs.filter(input => input.state === 'pending' && input.kind !== 'prompt').length > 0 && <small>有待处理输入</small>}{active && <Button size="sm" variant="outline" onClick={() => act(request({ type: 'runtime.cancel', sessionId: sessions.selected! }))}>停止</Button>}{runtime.snapshot.error && <span role="alert">{runtime.snapshot.error}</span>}</div>}
            <div className="workspace-hint"><FolderOpen size={15} /><span title={current?.workspace ?? info?.workspaceRoot}>{current ? current.workspace.split('/').slice(-2).join('/') : '会话独立工作区'}</span><button aria-label="选择新会话工作区" title="在指定位置新建会话" onClick={() => act(newSession(true))}><ChevronDown size={12} /></button><span className="hint-separator" /><ShieldCheck size={13} /><span>外部写入需审批</span></div>
            <div className="composer">
              {files.length > 0 && <div className="attachment-list">{files.map(file => <span key={file.id} title={file.path}><Table2 size={13} /><span>{file.name}{file.missing ? ' · 文件缺失' : ''}</span><button aria-label={`移除文件 ${file.name}`} onClick={() => act(sessions.removeFile(file.id))}><X size={12} /></button></span>)}</div>}
              <textarea aria-label="分析需求" placeholder="描述你的分析需求，或先添加 CSV 文件…" value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={event => { if (event.key === 'Enter' && event.metaKey) { event.preventDefault(); void send(); } }} rows={4} />
              <div className="composer-bottom"><Button size="icon" variant="ghost" aria-label="添加 CSV 文件" onClick={() => act(sessions.pickFiles())}><Plus /></Button><span className="attachment-hint">CSV · 多文件</span><div className="composer-spacer" />{active && <select className="input-kind" aria-label="运行中输入方式" value={inputKind} onChange={event => setInputKind(event.target.value as 'steer' | 'followUp')}><option value="steer">插话</option><option value="followUp">后续提问</option></select>}<button className="model-button" onClick={() => setSettings(true)}><Sparkles size={14} />{models?.configuredProviders.includes(models.selected.provider) ? models.models.find(model => model.provider === models.selected.provider && model.model === models.selected.model)?.name ?? models.selected.model : '配置模型'}<ChevronDown size={13} /></button><Button size="icon" aria-label="发送分析需求" disabled={!draft.trim() || sending || Boolean(current?.error) || Boolean(active && runtime.snapshot?.state !== 'running')} onClick={() => void send()} title="发送 · ⌘ Enter"><ArrowUp /></Button></div>
            </div>
            <div className="composer-caption">你的文件在本机处理，必要的内容会发送给所选模型。</div>
          </div>
          {history.length === 0 && <div className="idea-grid">{ideas.map(({ icon: Icon, title, prompt }) => <button className="idea-card" key={title} onClick={() => setDraft(prompt)}><div><Icon size={17} /><strong>{title}</strong></div><p>{prompt}</p></button>)}</div>}
        </section>
        <footer className="workspace-footer"><span><span className="status-dot muted" />自然语言 · 本地文件 · 可追溯过程</span><span>AI 生成的内容请结合业务判断</span></footer>
      </main>
      {panel && <aside className="result-panel" aria-label="结果面板"><div className="result-header"><strong>文件与产物</strong><Button size="icon" variant="ghost" aria-label="关闭结果面板" onClick={() => setPanel(false)}><X /></Button></div><div className="tabs" role="tablist" aria-label="产物类别"><button role="tab" aria-selected={tab === 'files'} onClick={() => setTab('files')}>文件</button><button role="tab" aria-selected={tab === 'reports'} onClick={() => setTab('reports')}>报告</button></div>{tab === 'files' && files.length ? <div className="file-list">{files.map(file => <div key={file.id}><Table2 size={20} /><strong>{file.name}</strong><span>{file.path}</span><small>{file.missing ? '原文件不可用' : `${file.size.toLocaleString()} bytes · 原文件引用`}</small></div>)}</div> : <div className="result-empty">{tab === 'files' ? <FolderOpen size={30} strokeWidth={1.2} /> : <FileText size={30} strokeWidth={1.2} />}<h3>{tab === 'files' ? '还没有文件' : '还没有报告'}</h3><p>{tab === 'files' ? '添加的 CSV 与生成的文件会在这里汇集。' : 'Agent 生成的报告与图表会在这里展示。'}</p></div>}</aside>}
    </div>
    <Dialog open={renaming} onOpenChange={setRenaming}><DialogContent><DialogTitle className="text-lg font-semibold">重命名会话</DialogTitle><DialogDescription className="mt-2 text-sm text-muted-foreground">为这个分析起一个容易找到的名字。</DialogDescription><form onSubmit={event => { event.preventDefault(); act(sessions.rename(title).then(() => setRenaming(false))); }}><input className="rename-input" aria-label="会话标题" value={title} onChange={event => setTitle(event.target.value)} maxLength={120} required /><Button type="submit">保存名称</Button></form></DialogContent></Dialog>
    <Dialog open={settings} onOpenChange={setSettings}><DialogContent><DialogTitle className="text-xl font-semibold">设置</DialogTitle><DialogDescription className="mt-2 text-sm text-muted-foreground">管理模型与本地工作环境</DialogDescription><ModelSettings value={models} onChange={setModels} onError={setError} /><div className="settings-section"><h3><FolderOpen size={15} />本地工作区</h3><p className="path-label">{info?.workspaceRoot ?? '正在加载…'}</p><p>每个会话使用独立目录，原始 CSV 不会被复制或移动。</p></div><details className="diagnostics"><summary><Activity size={15} />应用诊断</summary><dl><dt>版本</dt><dd>{info?.version}</dd><dt>平台</dt><dd>{info?.platform} / {info?.architecture}</dd><dt>本地存储</dt><dd>{info?.sqliteVersion ? 'SQLite 已连接' : '连接中'}</dd></dl><Button size="sm" variant="outline" onClick={() => void checkConnection()}>检查连接</Button><span role="status" className="ping-result">{ping}</span></details></DialogContent></Dialog>
  </div>;
}
