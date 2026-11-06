import { useEffect, useState } from 'react';
import { Activity, ArrowUp, ChartNoAxesCombined, ChevronDown, FileChartColumn, FileText, FolderOpen, Layers3, PanelLeftClose, PanelLeftOpen, PanelRight, Plus, Search, Settings2, ShieldCheck, Sparkles, Table2, X } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../components/ui/dialog';
import type { SystemInfo } from '../../shared/contracts/ipc';

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
  useEffect(() => {
    let mounted = true;
    const refresh = () => window.dataAgent.request({ type: 'system.info' }).then((r) => {
      if (!mounted) return;
      if (r.ok) setInfo(r.value as SystemInfo); else setError(r.error.message);
    }).catch(() => { if (mounted) setError('无法连接桌面服务，请重新打开应用。'); });
    void refresh();
    const unsubscribe = window.dataAgent.subscribe(() => void refresh());
    return () => { mounted = false; unsubscribe(); };
  }, []);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!event.metaKey) return;
      if (event.key === ',') { event.preventDefault(); setSettings(true); }
      if (event.key.toLowerCase() === 'n') { event.preventDefault(); setDraft(''); document.querySelector<HTMLTextAreaElement>('textarea[aria-label="分析需求"]')?.focus(); }
      if (event.key.toLowerCase() === 'k') {
        event.preventDefault(); setSidebar(true);
        requestAnimationFrame(() => document.querySelector<HTMLInputElement>('input[aria-label="搜索会话"]')?.focus());
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);
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
        <Button variant="secondary" className="new-chat" onClick={() => setDraft('')}><Plus size={17} />新会话<span>⌘ N</span></Button>
        <label className="search"><Search size={15} /><input aria-label="搜索会话" placeholder="搜索会话" value={search} onChange={(e) => setSearch(e.target.value)} /><kbd>⌘ K</kbd></label>
        <div className="section-label">工作空间<span>0</span></div>
        <div className="session-empty"><Layers3 size={22} strokeWidth={1.3} /><p>{search ? '没有匹配的会话' : '从一个问题开始'}</p><small>你的分析与发现，将留在这里</small></div>
        <div className="sidebar-bottom"><div className="local-badge"><span className={info?.hostStatus === 'ready' ? 'status-dot' : 'status-dot muted'} /><span data-testid="host-status">{info?.hostStatus === 'ready' ? '本地工作台已就绪' : info?.hostStatus === 'exited' ? 'Agent 连接已断开' : '正在启动工作台'}</span></div><Button variant="ghost" className="settings-button" aria-label="设置" onClick={() => setSettings(true)}><Settings2 />设置<span>⌘ ,</span></Button></div>
      </aside>}
      <main className="main-area">
        <header className="workspace-header"><Button size="icon" variant="ghost" aria-label={sidebar ? '收起侧栏' : '展开侧栏'} onClick={() => setSidebar(!sidebar)}>{sidebar ? <PanelLeftClose /> : <PanelLeftOpen />}</Button><span className="breadcrumb">工作台<span>/</span><strong>新会话</strong></span><div className="header-actions"><span className="privacy-label"><ShieldCheck size={14} />文件保留在本地</span><Button size="icon" variant="ghost" aria-label="切换结果面板" aria-pressed={panel} onClick={() => setPanel(!panel)}><PanelRight /></Button></div></header>
        {error && <div role="alert" className="error-banner">{error}<button aria-label="关闭错误" onClick={() => setError('')}><X size={16} /></button></div>}
        <section className="welcome">
          <div className="welcome-icon"><ChartNoAxesCombined size={28} strokeWidth={1.5} /></div>
          <div className="eyebrow">FROM DATA TO UNDERSTANDING</div>
          <h1>让数据，回答你的问题。</h1>
          <p className="welcome-copy">带上你的数据，说说你想了解什么。<br />让 AI 协助探索、绘图，把发现整理成报告。</p>
          <div className="composer-wrap">
            <div className="workspace-hint"><FolderOpen size={15} /><span title={info?.workspaceRoot}>{info ? '会话独立工作区' : '准备工作区'}</span><ChevronDown size={12} /><span className="hint-separator" /><ShieldCheck size={13} /><span>外部写入需审批</span></div>
            <div className="composer">
              <textarea aria-label="分析需求" placeholder="描述你的分析需求，或先添加 CSV 文件…" value={draft} onChange={(e) => setDraft(e.target.value)} rows={4} />
              <div className="composer-bottom"><Button size="icon" variant="ghost" aria-label="添加 CSV 文件" disabled title="文件选择将在会话功能中启用"><Plus /></Button><span className="attachment-hint">CSV · 多文件</span><div className="composer-spacer" /><button className="model-button" onClick={() => setSettings(true)}><Sparkles size={14} />配置模型<ChevronDown size={13} /></button><Button size="icon" aria-label="发送分析需求" disabled title="先配置模型"><ArrowUp /></Button></div>
            </div>
            <div className="composer-caption">你的文件在本机处理，必要的内容会发送给所选模型。</div>
          </div>
          <div className="idea-grid">{ideas.map(({ icon: Icon, title, prompt }) => <button className="idea-card" key={title} onClick={() => setDraft(prompt)}><div><Icon size={17} /><strong>{title}</strong></div><p>{prompt}</p></button>)}</div>
        </section>
        <footer className="workspace-footer"><span><span className="status-dot muted" />自然语言 · 本地文件 · 可追溯过程</span><span>AI 生成的内容请结合业务判断</span></footer>
      </main>
      {panel && <aside className="result-panel" aria-label="结果面板"><div className="result-header"><strong>文件与产物</strong><Button size="icon" variant="ghost" aria-label="关闭结果面板" onClick={() => setPanel(false)}><X /></Button></div><div className="tabs" role="tablist" aria-label="产物类别"><button role="tab" aria-selected={tab === 'files'} onClick={() => setTab('files')}>文件</button><button role="tab" aria-selected={tab === 'reports'} onClick={() => setTab('reports')}>报告</button></div><div className="result-empty">{tab === 'files' ? <FolderOpen size={30} strokeWidth={1.2} /> : <FileText size={30} strokeWidth={1.2} />}<h3>{tab === 'files' ? '还没有文件' : '还没有报告'}</h3><p>{tab === 'files' ? '添加的 CSV 与生成的文件会在这里汇集。' : 'Agent 生成的报告与图表会在这里展示。'}</p></div></aside>}
    </div>
    <Dialog open={settings} onOpenChange={setSettings}><DialogContent><DialogTitle className="text-xl font-semibold">设置</DialogTitle><DialogDescription className="mt-2 text-sm text-muted-foreground">管理模型与本地工作环境</DialogDescription><div className="settings-section"><h3>模型连接</h3><p>尚未配置模型。模型连接功能将在会话服务接入后启用。</p></div><div className="settings-section"><h3><FolderOpen size={15} />本地工作区</h3><p className="path-label">{info?.workspaceRoot ?? '正在加载…'}</p><p>每个会话使用独立目录，原始 CSV 不会被复制或移动。</p></div><details className="diagnostics"><summary><Activity size={15} />应用诊断</summary><dl><dt>版本</dt><dd>{info?.version}</dd><dt>平台</dt><dd>{info?.platform} / {info?.architecture}</dd><dt>本地存储</dt><dd>{info?.sqliteVersion ? 'SQLite 已连接' : '连接中'}</dd></dl><Button size="sm" variant="outline" onClick={() => void checkConnection()}>检查连接</Button><span role="status" className="ping-result">{ping}</span></details></DialogContent></Dialog>
  </div>;
}
