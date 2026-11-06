import { randomUUID } from 'node:crypto';
import type { HostRequest } from '../shared/contracts/host';
import type { ToolOperation, ToolResult, Interaction } from '../shared/tools';

export interface ToolExecutor {
  advanceOutput?(inputId: string): Promise<string>;
  execute(toolCallId: string, operation: ToolOperation, signal: AbortSignal | undefined, update: (output: string) => void): Promise<ToolResult>;
  subscribe(listener: (interactions: Interaction[]) => void): () => void;
}
export class ToolClient implements ToolExecutor {
  private outputs = new Map<string, { resolve: (directory: string) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private pending = new Map<string, { resolve: (result: ToolResult) => void; update: (text: string) => void; cleanup: () => void }>();
  private interactions = new Map<string, Interaction>();
  private listeners = new Set<(interactions: Interaction[]) => void>();
  constructor(private post: (message: unknown) => void) {}
  advanceOutput(inputId: string) {
    const id = randomUUID();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { this.outputs.delete(id); reject(new Error('产物版本分配超时')); }, 30_000);
      this.outputs.set(id, { resolve, reject, timer }); this.post({ type: 'output.advance', id, inputId });
    });
  }
  execute(toolCallId: string, operation: ToolOperation, signal: AbortSignal | undefined, update: (output: string) => void) {
    signal?.throwIfAborted();
    const id = randomUUID();
    return new Promise<ToolResult>(resolve => {
      const cancel = () => this.post({ type: 'tool.cancel', id, toolCallId });
      this.pending.set(id, { resolve, update, cleanup: () => signal?.removeEventListener('abort', cancel) });
      signal?.addEventListener('abort', cancel, { once: true });
      this.post({ type: 'tool.request', id, toolCallId, operation });
      if (signal?.aborted) cancel();
    });
  }
  receive(message: HostRequest) {
    if (message.type === 'output.result') {
      const pending = this.outputs.get(message.id);
      if (pending) { clearTimeout(pending.timer); this.outputs.delete(message.id); if (message.directory) pending.resolve(message.directory); else pending.reject(new Error(message.error || '无法切换产物版本')); }
      return true;
    }
    if (!['tool.result', 'tool.update', 'tool.interaction'].includes(message.type)) return false;
    const pending = this.pending.get(message.id); if (!pending) return true;
    if (message.type === 'tool.update') pending.update(message.output);
    if (message.type === 'tool.interaction') {
      if (message.interaction) this.interactions.set(message.id, message.interaction); else this.interactions.delete(message.id);
      this.changed();
    }
    if (message.type === 'tool.result') {
      this.pending.delete(message.id); this.interactions.delete(message.id); this.changed(); pending.cleanup(); pending.resolve(message.result);
    }
    return true;
  }
  private changed() { for (const listener of this.listeners) listener(structuredClone([...this.interactions.values()])); }
  subscribe(listener: (interactions: Interaction[]) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
}
