import { Brain, ChevronDown, Terminal } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { MessageView, ToolView } from '../../../shared/runtime';
import { PagedText } from './PagedText';
import { ToolLogViewer } from './ToolLogViewer';

export function ExecutionProcess({
  sessionId,
  messages,
  tools,
  results,
  active,
  onInspect,
}: {
  sessionId: string;
  messages: MessageView[];
  tools: Map<string, ToolView>;
  results: Map<string | undefined, MessageView>;
  active: boolean;
  onInspect: () => void;
}) {
  const [open, setOpen] = useState(active);
  const region = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const contentId = useId();
  // Only the active -> settled transition closes it. Later snapshot updates must
  // not undo a user's decision to reopen a finished turn.
  useEffect(() => {
    if (!active && region.current?.contains(document.activeElement)) toggle.current?.focus();
    setOpen(active);
  }, [active]);
  const entries = messages.flatMap((message, messageIndex) =>
    message.blocks.flatMap((block, index) =>
      block.type === 'text' || (block.type === 'thinking' && !block.text)
        ? []
        : [
            {
              key: block.type === 'toolCall' ? block.id : `thinking:${messageIndex}:${index}`,
              block,
            },
          ],
    ),
  );
  const toolEntries = entries.filter((entry) => entry.block.type === 'toolCall');
  const statusOf = (id: string) =>
    tools.get(id)?.status ??
    (results.get(id)
      ? results.get(id)?.isError
        ? 'failed'
        : 'completed'
      : active
        ? 'running'
        : 'failed');
  const failures = toolEntries.filter(
    ({ block }) => block.type === 'toolCall' && statusOf(block.id) === 'failed',
  ).length;
  if (!entries.length) return null;
  return (
    <section
      ref={region}
      className="execution-process"
      aria-label="执行过程"
      data-active={active}
      onPointerDown={onInspect}
      onKeyDown={onInspect}
    >
      <button
        className="process-toggle"
        ref={toggle}
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen(!open)}
      >
        <ChevronDown size={15} className={open ? 'expanded' : ''} />
        <span>{active ? '执行中' : '执行过程'}</span>
        <span className="process-count">
          {toolEntries.length ? `${toolEntries.length} 次工具调用` : '思考'}
        </span>
        {failures > 0 && <span className="process-failures">{failures} 次工具失败</span>}
      </button>
      <div id={contentId} hidden={!open} className="process-entries">
        {entries.map(({ key, block }) => {
          if (block.type === 'thinking')
            return (
              <details className="thinking-card" key={key}>
                <summary>
                  <Brain size={15} />
                  <span>思考</span>
                  <span className="process-excerpt">{block.text.replace(/\s+/g, ' ')}</span>
                </summary>
                <div>
                  <PagedText text={block.text}>{(part) => <pre>{part}</pre>}</PagedText>
                </div>
              </details>
            );
          if (block.type !== 'toolCall') return null;
          const live = tools.get(block.id),
            result = results.get(block.id),
            status = statusOf(block.id);
          const output =
            live?.output ??
            result?.blocks
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n');
          return (
            <details className="tool-card" data-tool-id={block.id} key={key}>
              <summary>
                <Terminal size={15} />
                <span>{block.name}</span>
                <span className="process-excerpt">{live?.arguments ?? block.arguments}</span>
                <small data-status={status}>
                  {status === 'running' ? '执行中' : status === 'failed' ? '执行失败' : '已结束'}
                </small>
              </summary>
              <div>
                <h4>参数</h4>
                <PagedText text={live?.arguments ?? block.arguments}>
                  {(part) => <pre>{part}</pre>}
                </PagedText>
                <h4>结果</h4>
                <PagedText
                  text={output || (active ? '等待工具结果…' : '执行已结束，未收到完整工具结果')}
                >
                  {(part) => <pre>{part}</pre>}
                </PagedText>
                {['bash', 'grep', 'find'].includes(block.name) && (
                  <ToolLogViewer sessionId={sessionId} toolCallId={block.id} />
                )}
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}
