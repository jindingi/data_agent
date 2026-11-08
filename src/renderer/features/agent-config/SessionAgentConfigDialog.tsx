import { useEffect, useState } from 'react';
import type { SessionAgentConfig } from '../../../shared/agent-config';
import { request } from '../../lib/desktop';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '../../components/ui/dialog';
import { Button } from '../../components/ui/button';
import { AgentConfigDetails } from './AgentConfigDetails';
export function SessionAgentConfigDialog({
  sessionId,
  close,
  newConversation,
}: {
  sessionId: string;
  close: () => void;
  newConversation: () => void;
}) {
  const [value, setValue] = useState<SessionAgentConfig>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void request({ type: 'sessions.agentConfig', sessionId })
      .then((result) => {
        if (active) setValue(result);
      })
      .catch((error) => {
        if (active) setError(error.message);
      });
    return () => {
      active = false;
    };
  }, [sessionId]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="agent-config-dialog">
        <DialogTitle>此会话的 Agent 配置</DialogTitle>
        <DialogDescription>创建会话时固定，不随默认配置更新。</DialogDescription>
        {error && <p role="alert">{error}</p>}
        {!value && !error && <p role="status">正在读取配置…</p>}
        {value && (
          <>
            {value.binding ? (
              <AgentConfigDetails binding={value.binding} prompt={value.prompt} />
            ) : (
              <p role="alert" className="maintenance-error">
                配置待确认：{value.error}。原会话已保留，可使用最新配置新建会话。
              </p>
            )}
            <p>
              当前默认配置为 v{value.defaultRevision}。
              {value.binding?.revision !== null &&
                value.binding &&
                `此会话继续使用 v${value.binding.revision}。`}
            </p>
            <Button
              variant="outline"
              onClick={() => {
                close();
                newConversation();
              }}
            >
              使用最新配置新建会话
            </Button>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
