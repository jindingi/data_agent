import { ArrowDown, ArrowUp } from 'lucide-react';
import { request } from '../../lib/desktop';
import { useEffect, useLayoutEffect, useRef, useState, useMemo } from 'react';
import { Streamdown } from 'streamdown';
import { Button } from '../../components/ui/button';
import { PagedText } from './PagedText';
import { ToolLogViewer } from './ToolLogViewer';
import type { MessageView, ToolView } from '../../../shared/runtime';

const components = {
  img: ({ alt }: { alt?: string }) => (
    <span className="blocked-media">[图片：{alt || '请在产物面板查看'}]</span>
  ),
  a: ({ href, children }: { href?: string; children?: React.ReactNode }) =>
    /^https?:\/\//i.test(href ?? '') ? (
      <SafeLink href={href!}>{children}</SafeLink>
    ) : (
      <span>{children}</span>
    ),
};
function SafeLink({ href, children }: { href: string; children?: React.ReactNode }) {
  const [error, setError] = useState('');
  return (
    <>
      <button
        className="artifact-link"
        onClick={() => {
          void request({ type: 'link.open', url: href }).catch((error) => setError(error.message));
        }}
      >
        {children}
      </button>
      {error && <span role="alert">{error}</span>}
    </>
  );
}
export function Markdown({ text, pending = false }: { text: string; pending?: boolean }) {
  return (
    <Streamdown
      mode="streaming"
      isAnimating={pending}
      controls={false}
      skipHtml
      rehypePlugins={[]}
      components={components}
      urlTransform={(url) => url}
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
  const [first, setFirst] = useState<number | null>(null);
  const [away, setAway] = useState(false);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const visible = useMemo(
    () =>
      messages.filter(
        (message) =>
          message.role !== 'toolResult' && message.blocks.length > 0 && message.role !== 'system',
      ),
    [messages],
  );
  const start = first ?? Math.max(0, visible.length - 20);
  useLayoutEffect(() => {
    if (first === null && visible.length) setFirst(Math.max(0, visible.length - 20));
  }, [first, visible.length]);
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
  useLayoutEffect(() => {
    const node = list.current;
    if (node && anchor.current) {
      node.scrollTop = anchor.current.top + node.scrollHeight - anchor.current.height;
      anchor.current = null;
    }
  }, [first]);
  useEffect(() => {
    const node = list.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      if (follow.current) node.scrollTop = node.scrollHeight;
    });
    if (node.firstElementChild) observer.observe(node.firstElementChild);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (follow.current && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [messages]);
  function earlier() {
    const node = list.current!;
    follow.current = false;
    anchor.current = { height: node.scrollHeight, top: node.scrollTop };
    setFirst(Math.max(0, start - 20));
  }
  return (
    <div className="transcript-frame">
      <div
        ref={list}
        onScroll={() => {
          const node = list.current!;
          follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
          setAway(!follow.current);
        }}
        className="history-list"
        aria-label="会话消息"
      >
        <div className="transcript-content">
          {start > 0 && (
            <div className="history-load">
              <Button size="sm" variant="ghost" onClick={earlier}>
                <ArrowUp size={14} />
                加载更早消息
              </Button>
            </div>
          )}
          {visible.slice(start).map((message) => (
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
                      {message.role === 'user' ? (
                        <p>{block.text}</p>
                      ) : (
                        <Markdown text={block.text} pending={message.pending} />
                      )}
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
                        {status === 'running'
                          ? '执行中'
                          : status === 'failed'
                            ? '执行失败'
                            : '已结束'}
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
      </div>
      {away && (
        <div className="jump-latest">
          <Button
            size="icon"
            variant="outline"
            aria-label="回到最新消息"
            onClick={() => {
              follow.current = true;
              list.current!.scrollTop = list.current!.scrollHeight;
              setAway(false);
            }}
          >
            <ArrowDown />
          </Button>
        </div>
      )}
    </div>
  );
}
