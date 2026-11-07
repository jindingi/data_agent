import * as Menu from '@radix-ui/react-dropdown-menu';
import { MoreHorizontal } from 'lucide-react';
import {
  Moon,
  Sun,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  Pencil,
  Archive,
  ArchiveRestore,
  Trash2,
} from 'lucide-react';
import { Button } from '../../components/ui/button';
import type { SessionRecord } from '../../../shared/models';
export function SessionHeader({
  current,
  sidebar,
  setSidebar,
  panel,
  setPanel,
  theme,
  onTheme,
  onRename,
  onArchive,
  onDelete,
}: {
  current?: SessionRecord;
  sidebar: boolean;
  setSidebar: (value: boolean) => void;
  panel: boolean;
  setPanel: (value: boolean) => void;
  theme: 'light' | 'dark';
  onTheme: (value: 'light' | 'dark') => void;
  onRename: () => void;
  onArchive: () => void;
  onDelete: () => void;
}) {
  return (
    <header className="workspace-header">
      <Button
        size="icon"
        variant="ghost"
        aria-label={sidebar ? '收起侧栏' : '展开侧栏'}
        onClick={() => setSidebar(!sidebar)}
      >
        {sidebar ? <PanelLeftClose /> : <PanelLeftOpen />}
      </Button>
      <span className="breadcrumb" data-testid="session-title" data-session-id={current?.id}>
        <strong>{current?.title ?? '新会话'}</strong>
      </span>
      <div className="header-actions">
        <Button
          size="icon"
          variant="ghost"
          aria-label={theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
          title={theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
          onClick={() => {
            const next = theme === 'dark' ? 'light' : 'dark';
            onTheme(next);
          }}
        >
          {theme === 'dark' ? <Sun /> : <Moon />}
        </Button>
        {current && (
          <Menu.Root>
            <Menu.Trigger asChild>
              <Button size="icon" variant="ghost" aria-label="会话操作">
                <MoreHorizontal />
              </Button>
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Content className="menu-content" align="end" sideOffset={6}>
                <Menu.Item className="menu-item" onSelect={onRename}>
                  <Pencil size={16} />
                  重命名会话
                </Menu.Item>
                <Menu.Item className="menu-item" onSelect={onArchive}>
                  {current.archived ? <ArchiveRestore size={16} /> : <Archive size={16} />}
                  {current.archived ? '恢复会话' : '归档会话'}
                </Menu.Item>
                <Menu.Item className="menu-item danger" onSelect={onDelete}>
                  <Trash2 size={16} />
                  删除会话
                </Menu.Item>
              </Menu.Content>
            </Menu.Portal>
          </Menu.Root>
        )}
        <Button
          size="icon"
          variant="ghost"
          aria-label="切换结果面板"
          aria-pressed={panel}
          onClick={() => setPanel(!panel)}
        >
          <PanelRight />
        </Button>
      </div>
    </header>
  );
}
