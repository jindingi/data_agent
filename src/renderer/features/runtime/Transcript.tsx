import { ArrowDown, ArrowUp } from 'lucide-react';
import { request } from '../../lib/desktop';
import { useEffect, useLayoutEffect, useRef, useState, useMemo } from 'react';
import { Streamdown } from 'streamdown';
import { Button } from '../../components/ui/button';
import { ExecutionProcess } from './ExecutionProcess';
import { TurnUsage } from './TurnUsage';
import type { TurnUsage as Usage } from '../../../shared/usage';
import { transcriptTurns } from './transcript-turns';
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
  active = false,
  turnUsage = [],
}: {
  sessionId: string;
  messages: MessageView[];
  tools: ToolView[];
  active?: boolean;
  turnUsage?: Usage[];
}) {
  const list = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [first, setFirst] = useState<number | null>(null);
  const [away, setAway] = useState(false);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const turns = useMemo(() => transcriptTurns(messages), [messages]);
  const usageMap = useMemo(
    () => new Map(turnUsage.map((usage) => [usage.inputId, usage])),
    [turnUsage],
  );
  const start = first ?? Math.max(0, turns.length - 10);
  useLayoutEffect(() => {
    if (first === null && turns.length) setFirst(Math.max(0, turns.length - 10));
  }, [first, turns.length]);
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
    setFirst(Math.max(0, start - 10));
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
          {turns.slice(start).map((turn, index) => (
            <div className="transcript-turn" key={turn.id} data-turn-id={turn.id}>
              {turn.user && <MessageContent message={turn.user} />}
              <ExecutionProcess
                sessionId={sessionId}
                messages={turn.replies}
                tools={toolMap}
                results={results}
                active={active && start + index === turns.length - 1}
                onInspect={() => {
                  follow.current = false;
                }}
              />
              {turn.replies
                .filter((message) =>
                  message.blocks.some((block) => block.type === 'text' && block.text),
                )
                .map((message) => (
                  <MessageContent key={message.id} message={message} />
                ))}
              {usageMap.has(turn.id) && (
                <TurnUsage
                  usage={usageMap.get(turn.id)!}
                  onInspect={() => {
                    follow.current = false;
                  }}
                />
              )}
            </div>
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

function MessageContent({ message }: { message: MessageView }) {
  return (
    <article className={`history-message ${message.role}`} data-message-id={message.id}>
      <div className="message-author">
        {message.role === 'user' ? '你' : message.role === 'assistant' ? 'Data Agent' : '运行记录'}
      </div>
      {message.paths?.length ? (
        <div className="message-attachments" aria-label="本次附件">
          {message.paths.map((path) => (
            <span key={path} title={path}>
              {path.split('/').pop()}
            </span>
          ))}
        </div>
      ) : null}
      {message.blocks.map((block, index) =>
        block.type === 'text' ? (
          <div className="markdown-body" key={index}>
            {message.role === 'user' ? (
              <p>{block.text}</p>
            ) : (
              <Markdown text={block.text} pending={message.pending} />
            )}
          </div>
        ) : null,
      )}
    </article>
  );
}
