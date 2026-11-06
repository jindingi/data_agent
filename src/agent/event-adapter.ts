import type { AgentSessionEvent, SessionManager } from '@earendil-works/pi-coding-agent';
import type { MessageView, RuntimeSnapshot, ToolView } from '../shared/runtime';
import { messageText, type InputIdentity } from './input-identity';

const LIMIT = 64 * 1024;
export function bounded(text: string) { return text.length <= LIMIT ? text : `${text.slice(0, LIMIT)}\n…（显示已截断）`; }
function stringify(value: unknown) { try { return bounded(JSON.stringify(value) ?? ''); } catch { return '[不可显示]'; } }
export function projectMessage(id: string, raw: { role: string; content?: unknown; toolCallId?: string; isError?: boolean }, strip: (text: string) => string): MessageView {
  const blocks: MessageView['blocks'] = [];
  if (typeof raw.content === 'string') blocks.push({ type: 'text', text: bounded(raw.role === 'user' ? strip(raw.content) : raw.content) });
  else if (Array.isArray(raw.content)) for (const block of raw.content) {
    if (block.type === 'text') blocks.push({ type: 'text', text: bounded(raw.role === 'user' ? strip(block.text) : block.text) });
    if (block.type === 'thinking') blocks.push({ type: 'thinking', text: bounded(block.thinking) });
    if (block.type === 'toolCall') blocks.push({ type: 'toolCall', id: block.id, name: block.name, arguments: stringify(block.arguments) });
  }
  return { id, role: raw.role, blocks, ...(raw.toolCallId ? { toolCallId: raw.toolCallId, isError: raw.isError } : {}) };
}
/** Owns immutable projections, never references SDK's mutable partial objects. */
export class EventAdapter {
  private messages: MessageView[] = [];
  private tools = new Map<string, ToolView>();
  private currentId: string | null = null;
  private ordinal = 0;
  private seq = 0;
  private ids: Pick<RuntimeSnapshot, 'sessionId' | 'runId' | 'hostEpoch'>;
  state: RuntimeSnapshot['state'] = 'starting';
  error: string | null = null;
  constructor(ids: Pick<RuntimeSnapshot, 'sessionId' | 'runId' | 'hostEpoch'>, private identity: InputIdentity) {
    // TypeScript Pick is not runtime filtering: never retain/spread the full run config.
    this.ids = { sessionId: ids.sessionId, runId: ids.runId, hostEpoch: ids.hostEpoch };
  }
  restore(manager: SessionManager) {
    this.messages = [];
    for (const entry of manager.getBranch()) {
      if (entry.type !== 'message') continue;
      this.messages.push(projectMessage(entry.id, entry.message, text => this.identity.strip(text)));
      const message = entry.message;
      if (message.role === 'assistant') for (const block of message.content) if (block.type === 'toolCall') {
        this.tools.set(block.id, { id: block.id, name: block.name, arguments: stringify(block.arguments), output: '', status: 'running' });
      }
      if (message.role === 'toolResult') {
        const tool = this.tools.get(message.toolCallId);
        if (tool) { tool.output = bounded(messageText(message)); tool.status = message.isError ? 'failed' : 'completed'; }
      }
    }
    this.currentId = null;
  }
  accept(event: AgentSessionEvent) {
    if (event.type === 'message_start') this.currentId = `${this.ids.hostEpoch}:${++this.ordinal}`;
    if (event.type === 'message_start' || event.type === 'message_update' || event.type === 'message_end') {
      const id = this.currentId ?? `${this.ids.hostEpoch}:${++this.ordinal}`;
      const message = projectMessage(id, event.message, text => this.identity.strip(text));
      message.pending = event.type !== 'message_end';
      const index = this.messages.findIndex(m => m.id === id);
      if (index === -1) this.messages.push(message); else this.messages[index] = message;
      if (event.type === 'message_end') this.currentId = null;
    }
    if (event.type === 'tool_execution_start') this.tools.set(event.toolCallId, { id: event.toolCallId, name: event.toolName, arguments: stringify(event.args), output: '', status: 'running' });
    if (event.type === 'tool_execution_update' || event.type === 'tool_execution_end') {
      const tool = this.tools.get(event.toolCallId);
      if (tool) { tool.output = bounded(messageText(event.type === 'tool_execution_update' ? event.partialResult : event.result)); if (event.type === 'tool_execution_end') tool.status = event.isError ? 'failed' : 'completed'; }
    }
  }
  snapshot(): RuntimeSnapshot {
    return structuredClone({ schemaVersion: 1, ...this.ids, seq: ++this.seq, state: this.state, messages: this.messages, tools: [...this.tools.values()], inputs: this.identity.snapshot(), queuedInputs: this.identity.pending(), error: this.error });
  }
}
