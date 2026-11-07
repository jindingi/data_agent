import { useEffect, useRef, useState, useMemo } from 'react';
import { Streamdown } from 'streamdown';
import { Button } from '../../components/ui/button';
import { PagedText } from './PagedText';
import { ToolLogViewer } from './ToolLogViewer';
import type { MessageView, ToolView } from '../../../shared/runtime';

const components = {
  img: ({ alt }: { alt?: string }) => (
    <span className="blocked-media">[图片：{alt || '请在产物面板查看'}]</span>
  ),
  a: ({ children }: { children?: React.ReactNode }) => (
    <span className="blocked-link">{children}</span>
  ),
};
export function Markdown({ text, pending = false }: { text: string; pending?: boolean }) {
  return (
    <Streamdown
      mode="streaming"
      isAnimating={pending}
      controls={false}
      skipHtml
      rehypePlugins={[]}
      components={components}
      urlTransform={() => undefined}
    >
      {text}
    </Streamdown>
  );
}
export function Transcript({
  sessionId,
  messages,
  tools,
}: {
  sessionId: string;
  messages: MessageView[];
  tools: ToolView[];
}) {
  const list = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [windowEnd, setWindowEnd] = useState<number | null>(null);
  const visible = useMemo(
    () =>
      messages.filter(
        (message) =>
          message.role !== 'toolResult' && message.blocks.length > 0 && message.role !== 'system',
      ),
    [messages],
  );
  const end = Math.min(windowEnd ?? visible.length, visible.length),
    start = Math.max(0, end - 20);
  const toolMap = useMemo(() => new Map(tools.map((tool) => [tool.id, tool])), [tools]);
  const results = useMemo(
    () =>
      new Map(
        messages
          .filter((message) => message.toolCallId)
          .map((message) => [message.toolCallId, message]),
      ),
    [messages],
  );
  function navigate(value: number | null) {
    setWindowEnd(value);
    follow.current = value === null;
    if (list.current) list.current.scrollTop = 0;
  }

  useEffect(() => {
    if (windowEnd === null && follow.current && list.current)
      list.current.scrollTop = list.current.scrollHeight;
  }, [messages, windowEnd]);
  return (
    <div
      ref={list}
      onScroll={() => {
        const node = list.current!;
        follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100;
      }}
      className="history-list"
      aria-label="会话消息"
    >
      {visible.length > 20 && (
        <nav className="history-pagination" aria-label="会话分页">
          <Button
            size="sm"
            variant="outline"
            disabled={start === 0}
            onClick={() => navigate(start)}
          >
            更早消息
          </Button>
          <span>
            {start + 1}–{end} / {visible.length}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={end === visible.length}
            onClick={() =>
              navigate(Math.min(end + 20, visible.length) === visible.length ? null : end + 20)
            }
          >
            较新消息
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={windowEnd === null}
            onClick={() => navigate(null)}
          >
            回到最新
          </Button>
        </nav>
      )}
      {visible.slice(start, end).map((message) => (
        <article
          key={message.id}
          className={`history-message ${message.role}`}
          data-message-id={message.id}
        >
          <div className="message-author">
            {message.role === 'user'
              ? '你'
              : message.role === 'assistant'
                ? 'Data Agent'
                : '运行记录'}
          </div>
          {message.blocks.map((block, index) => {
            if (block.type === 'text')
              return (
                <div className="markdown-body" key={index}>
                  <PagedText text={block.text}>
                    {(part) =>
                      message.role === 'user' ? (
                        <p>{part}</p>
                      ) : (
                        <Markdown text={part} pending={message.pending} />
                      )
                    }
                  </PagedText>
                </div>
              );
            if (block.type === 'thinking')
              return block.text ? (
                <details className="thinking-card" key={index}>
                  <summary>思考过程</summary>
                  <div>
                    <PagedText text={block.text}>{(part) => <pre>{part}</pre>}</PagedText>
                  </div>
                </details>
              ) : null;
            const live = toolMap.get(block.id);
            const result = results.get(block.id);
            const status =
              live?.status ?? (result ? (result.isError ? 'failed' : 'completed') : 'running');
            const output =
              live?.output ??
              result?.blocks
                .filter((b) => b.type === 'text')
                .map((b) => b.text)
                .join('\n');
            return (
              <details className="tool-card" data-tool-id={block.id} key={index}>
                <summary>
                  <span>{block.name}</span>
                  <small>
                    {status === 'running' ? '执行中' : status === 'failed' ? '执行失败' : '已结束'}
                  </small>
                </summary>
                <div>
                  <h4>参数</h4>
                  <PagedText text={live?.arguments ?? block.arguments}>
                    {(part) => <pre>{part}</pre>}
                  </PagedText>
                  <h4>结果</h4>
                  <PagedText text={output || '等待工具结果…'}>
                    {(part) => <pre>{part}</pre>}
                  </PagedText>
                  {['bash', 'grep', 'find'].includes(block.name) && (
                    <ToolLogViewer sessionId={sessionId} toolCallId={block.id} />
                  )}
                </div>
              </details>
            );
          })}
        </article>
      ))}
    </div>
  );
}
