import { existsSync, readFileSync } from 'node:fs';
import type { ContextEvent, Extension, SessionManager } from '@earendil-works/pi-coding-agent';
import type { RunInput, RuntimeSnapshot } from '../shared/runtime';

const prefix = /^\[data-agent-input:([\da-f-]{36})\]\n/i;
export function envelope(id: string, text: string) { return `[data-agent-input:${id}]\n${text}`; }
export function inputId(text: string) { return prefix.exec(text)?.[1]; }
export function messageText(message: { content?: unknown }) {
  return typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.filter(b => b.type === 'text').map(b => b.text).join('\n') : '';
}
/** Strip only an application-owned outer envelope; user-authored lookalikes remain literal. */
export function stripEnvelope(text: string, known: ReadonlySet<string>) {
  const id = inputId(text); return id && known.has(id) ? text.replace(prefix, '') : text;
}
export class InputIdentity {
  private inputs = new Map<string, RuntimeSnapshot['inputs'][number]>();
  private queued = new Map<string, RunInput>();
  readonly known = new Set<string>();
  constructor(private manager: SessionManager) {
    for (const entry of manager.getEntries()) {
      if (entry.type !== 'custom') continue;
      const data = entry.data as { inputId?: string; kind?: RunInput['kind']; entryId?: string } | undefined;
      if (!data?.inputId) continue;
      if (entry.customType === 'data_agent.input_submitted' && data.kind) {
        this.known.add(data.inputId); this.inputs.set(data.inputId, { inputId: data.inputId, kind: data.kind, state: 'unknown' });
      }
      if (entry.customType === 'data_agent.input_committed' && data.entryId) {
        const input = this.inputs.get(data.inputId); if (input) Object.assign(input, { state: 'committed', entryId: data.entryId });
      }
    }
    this.reconcile();
  }
  submit(input: RunInput) {
    if (this.known.has(input.inputId)) throw new Error('输入 ID 已使用，请勿重复发送');
    this.manager.appendCustomEntry('data_agent.input_submitted', { inputId: input.inputId, kind: input.kind });
    this.known.add(input.inputId); this.inputs.set(input.inputId, { inputId: input.inputId, kind: input.kind, state: 'pending' });
    this.queued.set(input.inputId, { ...input });
    return envelope(input.inputId, input.text);
  }
  reconcile() {
    const file = this.manager.getSessionFile();
    if (!file || !existsSync(file)) return;
    // message_end precedes native persistence: inspect disk only at a settled boundary.
    for (const line of readFileSync(file, 'utf8').trimEnd().split('\n')) {
      const entry = JSON.parse(line);
      if (entry.type !== 'message' || entry.message?.role !== 'user') continue;
      const id = inputId(messageText(entry.message)); const input = id ? this.inputs.get(id) : undefined;
      if (!input || input.state === 'committed') continue;
      this.manager.appendCustomEntry('data_agent.input_committed', { inputId: id, entryId: entry.id });
      Object.assign(input, { state: 'committed', entryId: entry.id });
      this.queued.delete(id!);
    }
  }
  settle(cancelled: boolean) {
    this.reconcile();
    for (const input of this.inputs.values()) if (input.state === 'pending') input.state = cancelled ? 'cancelled' : 'unknown';
  }
  snapshot() { return structuredClone([...this.inputs.values()]); }
  pending() { return structuredClone([...this.queued.values()]); }
  consumed(message: { content?: unknown }) { const id = inputId(messageText(message)); if (id) this.queued.delete(id); }
  strip(text: string) { return stripEnvelope(text, this.known); }
  context(event: ContextEvent) {
    return { messages: event.messages.map(message => message.role !== 'user' ? message : {
      ...message, content: typeof message.content === 'string' ? this.strip(message.content) : message.content.map(block => block.type === 'text' ? { ...block, text: this.strip(block.text) } : block),
    }) };
  }
}
/** A fully explicit public Extension value. No directory discovery or executable user resources. */
export function trustedExtension(handlers: Extension['handlers']): Extension {
  const path = 'builtin:data-agent';
  return { path, resolvedPath: path, sourceInfo: { path, source: 'builtin', scope: 'temporary', origin: 'top-level' }, handlers,
    tools: new Map(), messageRenderers: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map() };
}
