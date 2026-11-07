import { randomUUID } from 'node:crypto';
import type { HostRequest } from '../shared/contracts/host';
import type { ToolOperation, ToolResult, Interaction } from '../shared/tools';

export interface ToolExecutor {
  execute(
    toolCallId: string,
    operation: ToolOperation,
    signal: AbortSignal | undefined,
    update: (output: string) => void,
  ): Promise<ToolResult>;
  subscribe(listener: (interactions: Interaction[]) => void): () => void;
}
export class ToolClient implements ToolExecutor {
  private pending = new Map<
    string,
    { resolve: (result: ToolResult) => void; update: (text: string) => void; cleanup: () => void }
  >();
  private interactions = new Map<string, Interaction>();
  private listeners = new Set<(interactions: Interaction[]) => void>();
  constructor(private post: (message: unknown) => void) {}
  execute(
    toolCallId: string,
    operation: ToolOperation,
    signal: AbortSignal | undefined,
    update: (output: string) => void,
  ) {
    signal?.throwIfAborted();
    const id = randomUUID();
    return new Promise<ToolResult>((resolve) => {
      const cancel = () => this.post({ type: 'tool.cancel', id, toolCallId });
      this.pending.set(id, {
        resolve,
        update,
        cleanup: () => signal?.removeEventListener('abort', cancel),
      });
      signal?.addEventListener('abort', cancel, { once: true });
      this.post({ type: 'tool.request', id, toolCallId, operation });
      if (signal?.aborted) cancel();
    });
  }
  receive(message: HostRequest) {
    if (!['tool.result', 'tool.update', 'tool.interaction'].includes(message.type)) return false;
    const pending = this.pending.get(message.id);
    if (!pending) return true;
    if (message.type === 'tool.update') pending.update(message.output);
    if (message.type === 'tool.interaction') {
      if (message.interaction) this.interactions.set(message.id, message.interaction);
      else this.interactions.delete(message.id);
      this.changed();
    }
    if (message.type === 'tool.result') {
      this.pending.delete(message.id);
      this.interactions.delete(message.id);
      this.changed();
      pending.cleanup();
      pending.resolve(message.result);
    }
    return true;
  }
  private changed() {
    for (const listener of this.listeners)
      listener(structuredClone([...this.interactions.values()]));
  }
  subscribe(listener: (interactions: Interaction[]) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
