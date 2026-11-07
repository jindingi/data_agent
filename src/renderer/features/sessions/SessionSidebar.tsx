import { ChartNoAxesCombined, Plus, Search, FolderOpen, Layers3, Settings2 } from 'lucide-react';
import { Button } from '../../components/ui/button';
import type { useSessions } from './use-sessions';
import type { RuntimeSnapshot } from '../../../shared/runtime';
export function SessionSidebar({
  sessions,
  search,
  setSearch,
  archived,
  setArchived,
  activity,
  onNew,
  onSettings,
}: {
  sessions: ReturnType<typeof useSessions>;
  search: string;
  setSearch: (value: string) => void;
  archived: boolean;
  setArchived: (value: boolean) => void;
  activity: Record<string, RuntimeSnapshot['state']>;
  onNew: () => void;
  onSettings: () => void;
}) {
  return (
    <aside className="sidebar" aria-label="会话侧栏">
      <div className="brand">
        <div className="brand-mark">
          <ChartNoAxesCombined size={19} strokeWidth={2.2} />
        </div>
        <span>Data Agent</span>
      </div>
      <Button variant="secondary" className="new-chat" aria-label="新会话" onClick={() => onNew()}>
        <Plus size={17} />
        新会话<span>⌘ N</span>
      </Button>
      <label className="search">
        <Search size={15} />
        <input
          aria-label="搜索会话"
          placeholder="搜索会话"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <kbd>⌘ K</kbd>
      </label>
      <div className="section-label">
        <button
          onClick={() => setArchived(!archived)}
          aria-label={archived ? '查看活跃会话' : '查看归档会话'}
        >
          {archived ? '返回会话' : '查看归档'}
        </button>
        <span>{sessions.list.length}</span>
      </div>
      {sessions.list.length > 0 ? (
        <div className="session-list">
          {sessions.list.map((session) => (
            <button
              key={session.id}
              data-session-id={session.id}
              aria-label={`打开会话 ${session.title}`}
              aria-current={sessions.selected === session.id ? 'true' : undefined}
              onClick={() => sessions.select(session.id)}
            >
              <FolderOpen size={15} />
              <span>{session.title}</span>
              <small data-session-activity={activity[session.id] ?? 'idle'}>
                {(
                  {
                    queued: '排队中',
                    starting: '连接中',
                    running: '执行中',
                    waiting_approval: '待审批',
                    waiting_input: '待回答',
                  } as Record<string, string>
                )[activity[session.id]] ??
                  new Date(session.updatedAt).toLocaleDateString('zh-CN', {
                    month: 'numeric',
                    day: 'numeric',
                  })}
              </small>
            </button>
          ))}
        </div>
      ) : (
        <div className="session-empty">
          <Layers3 size={22} strokeWidth={1.3} />
          <p>{search ? '没有匹配的会话' : '从一个问题开始'}</p>
          <small>你的分析与发现，将留在这里</small>
        </div>
      )}
      <div className="sidebar-bottom">
        <Button
          variant="ghost"
          className="settings-button"
          aria-label="设置"
          onClick={() => onSettings()}
        >
          <Settings2 />
          设置<span>⌘ ,</span>
        </Button>
      </div>
    </aside>
  );
}
