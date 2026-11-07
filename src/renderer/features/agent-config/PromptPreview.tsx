import { useEffect, useState } from 'react';
import { agentConfigSchema, type AgentConfig } from '../../../shared/agent-config';
import { request } from '../../lib/desktop';
import { Button } from '../../components/ui/button';

export function PromptPreview({ config, revision }: { config: AgentConfig; revision: number }) {
  const [open, setOpen] = useState(false);
  const [retry, setRetry] = useState(0);
  const [result, setResult] = useState<{ key: string; text?: string; error?: string }>();
  const key = JSON.stringify({ config, revision, retry });
  const valid = agentConfigSchema.safeParse(config).success;
  useEffect(() => {
    if (!open || !valid) return;
    let active = true;
    const timer = setTimeout(() => {
      const { config, revision } = JSON.parse(key) as { config: AgentConfig; revision: number };
      void request({ type: 'agentConfig.preview', config, expectedRevision: revision })
        .then((value) => {
          if (active) setResult({ key, text: value.text });
        })
        .catch((error: unknown) => {
          if (active)
            setResult({ key, error: error instanceof Error ? error.message : '无法生成预览' });
        });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [open, valid, key]);
  const current = result?.key === key ? result : undefined;
  return (
    <details
      className="agent-config-details"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>查看完整系统提示词预览</summary>
      <p>
        使用当前草稿与实际 SDK 组装，保留标签和顺序；新会话工作区暂用占位路径。工具参数通过 API 的
        tools 字段单独发送。
      </p>
      {open &&
        (!valid ? (
          <p role="status">请先解决工具与 Skills 的配置冲突。</p>
        ) : current?.error ? (
          <p role="alert">
            {current.error}{' '}
            <Button variant="ghost" size="sm" onClick={() => setRetry((n) => n + 1)}>
              重试预览
            </Button>
          </p>
        ) : current?.text !== undefined ? (
          <pre aria-label="完整系统提示词预览">{current.text}</pre>
        ) : (
          <p role="status">正在组装预览…</p>
        ))}
    </details>
  );
}
