import { useEffect, useRef } from 'react';
import { Streamdown } from 'streamdown';
import type { MessageView, ToolView } from '../../../shared/runtime';

const components = {
  img: ({ alt }: { alt?: string }) => <span className="blocked-media">[图片：{alt || '请在产物面板查看'}]</span>,
  a: ({ children }: { children?: React.ReactNode }) => <span className="blocked-link">{children}</span>,
};
export function Markdown({ text, pending = false }: { text: string; pending?: boolean }) {
  return <Streamdown mode="streaming" isAnimating={pending} controls={false} skipHtml rehypePlugins={[]} components={components} urlTransform={() => undefined}>{text}</Streamdown>;
}
export function Transcript({ messages, tools }: { messages: MessageView[]; tools: ToolView[] }) {
  const list = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => { if (follow.current && list.current) list.current.scrollTop = list.current.scrollHeight; }, [messages]);
  return <div ref={list} onScroll={() => { const node = list.current!; follow.current = node.scrollHeight - node.scrollTop - node.clientHeight < 100; }} className="history-list" aria-label="会话消息">{messages.filter(message => message.role !== 'toolResult' && message.blocks.length > 0 && message.role !== 'system').map(message => <article key={message.id} className={`history-message ${message.role}`} data-message-id={message.id}>
    <div className="message-author">{message.role === 'user' ? '你' : message.role === 'assistant' ? 'Data Agent' : '运行记录'}</div>
    {message.blocks.map((block, index) => {
      if (block.type === 'text') return <div className="markdown-body" key={index}>{message.role === 'user' ? <p>{block.text}</p> : <Markdown text={block.text} pending={message.pending} />}</div>;
      if (block.type === 'thinking') return block.text ? <details className="thinking-card" key={index}><summary>思考过程</summary><div>{block.text}</div></details> : null;
      const live = tools.find(tool => tool.id === block.id);
      const result = messages.find(item => item.toolCallId === block.id);
      const status = live?.status ?? (result ? result.isError ? 'failed' : 'completed' : 'running');
      const output = live?.output ?? result?.blocks.filter(b => b.type === 'text').map(b => b.text).join('\n');
      return <details className="tool-card" data-tool-id={block.id} key={index}><summary><span>{block.name}</span><small>{status === 'running' ? '执行中' : status === 'failed' ? '执行失败' : '已结束'}</small></summary><div><h4>参数</h4><pre>{live?.arguments ?? block.arguments}</pre><h4>结果</h4><pre>{output || '等待工具结果…'}</pre></div></details>;
    })}
  </article>)}</div>;
}
