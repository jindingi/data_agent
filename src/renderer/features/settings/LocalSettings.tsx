import { useEffect, useState } from 'react';
import { Activity, FolderOpen } from 'lucide-react';
import type { SystemInfo } from '../../../shared/contracts/ipc';
import { Button } from '../../components/ui/button';
import { request } from '../../lib/desktop';
export function LocalSettings() {
  const [info, setInfo] = useState<SystemInfo>();
  const [ping, setPing] = useState('');
  const [checking, setChecking] = useState(false);
  useEffect(() => {
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
  }, []);
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
    <>
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
    </>
  );
}
