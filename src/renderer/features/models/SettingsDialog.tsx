import { useEffect, useState } from 'react';
import { Activity, FolderOpen } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../../components/ui/dialog';
import { ModelSettings } from './ModelSettings';
import { ProviderConnection, type ConnectionDrafts } from './ProviderConnection';
import type { ModelController } from './use-model-settings';
import type { SystemInfo } from '../../../shared/contracts/ipc';
import { request } from '../../lib/desktop';
export function SettingsDialog({
  open,
  onOpenChange,
  modelSettings,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  modelSettings: ModelController;
}) {
  const [info, setInfo] = useState<SystemInfo>();
  const [ping, setPing] = useState('');
  const [checking, setChecking] = useState(false);
  const [drafts, setDrafts] = useState<ConnectionDrafts>({});
  useEffect(() => {
    if (!open) return;
    let valid = true;
    void request({ type: 'system.info' })
      .then((value) => {
        if (valid) setInfo(value);
      })
      .catch((error) => {
        if (valid) setPing(error.message);
      });
    return () => {
      valid = false;
    };
  }, [open]);
  async function checkConnection() {
    setChecking(true);
    setPing('正在检查…');
    try {
      await request({ type: 'system.ping', text: 'desktop-health' });
      setPing('本地引擎正常（未测试模型 API）');
    } catch (error) {
      setPing(error instanceof Error ? error.message : '检查失败');
    } finally {
      setChecking(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="settings-dialog">
        <header className="settings-header">
          <DialogTitle className="text-xl font-semibold">设置</DialogTitle>
          <DialogDescription className="mt-2 text-sm text-muted-foreground">
            管理模型与本地工作环境
          </DialogDescription>
          {modelSettings.error && (
            <p role="alert" className="maintenance-error">
              {modelSettings.error}
            </p>
          )}
        </header>
        <div className="settings-body">
          {!modelSettings.value ? (
            modelSettings.error ? (
              <Button
                variant="outline"
                disabled={modelSettings.busy}
                onClick={() => void modelSettings.reload()}
              >
                重新加载模型设置
              </Button>
            ) : (
              <p role="status">正在加载模型设置…</p>
            )
          ) : (
            <>
              <ModelSettings controller={modelSettings} />
              <ProviderConnection
                controller={modelSettings}
                drafts={drafts}
                setDrafts={setDrafts}
              />
            </>
          )}
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
            <Button
              size="sm"
              variant="outline"
              disabled={checking}
              onClick={() => void checkConnection()}
            >
              检查本地引擎
            </Button>
            <span role="status" className="ping-result">
              {ping}
            </span>
          </details>
        </div>
      </DialogContent>
    </Dialog>
  );
}
