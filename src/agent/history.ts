import { dirname } from 'node:path';
import { projectTurnUsage } from './turn-usage';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { inspectSessionFile } from '../node/session-integrity';
import { AppError } from '../shared/errors';
import type { HistoryItem } from '../shared/models';
import { stripEnvelope, inputId, messageText } from './input-identity';
import { projectMessage } from './event-adapter';
import type { MessageView } from '../shared/runtime';

/** Only the Host owns native session access; preflight must succeed before open(). */
export function readHistory(file: string, workspace: string, expectedId: string) {
  const inspected = inspectSessionFile(file, expectedId, true);
  if (inspected.state !== 'persisted')
    throw new AppError('HISTORY_UNAVAILABLE', inspected.error || '会话历史不可用');
  const manager = SessionManager.open(file, dirname(file), workspace);
  const items: HistoryItem[] = [];
  const messages: MessageView[] = [];
  const known = new Set(
    manager
      .getEntries()
      .flatMap((entry) =>
        entry.type === 'custom' && entry.customType === 'data_agent.input_submitted'
          ? [(entry.data as { inputId: string }).inputId]
          : [],
      ),
  );
  const attachments = new Map(
    manager.getEntries().flatMap((entry) => {
      if (entry.type !== 'custom' || entry.customType !== 'data_agent.input_submitted') return [];
      const value = entry.data as { inputId: string; paths?: string[] };
      return [[value.inputId, value.paths ?? []] as const];
    }),
  );
  for (const entry of manager.getBranch()) {
    if (entry.type !== 'message') continue;
    const message = entry.message;
    const content = 'content' in message ? message.content : '';
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n')
          : '';
    items.push({
      id: entry.id,
      role: message.role,
      text: message.role === 'user' ? stripEnvelope(text, known) : text,
    });
    const view = projectMessage(entry.id, message, (text) => stripEnvelope(text, known));
    if (view.inputId) view.paths = attachments.get(view.inputId);
    messages.push(view);
  }
  const inputs = manager.getEntries().flatMap((entry) => {
    if (entry.type !== 'message' || entry.message.role !== 'user') return [];
    const id = inputId(messageText(entry.message));
    return id && known.has(id)
      ? [{ inputId: id, state: 'committed' as const, entryId: entry.id }]
      : [];
  });
  return {
    piSessionId: manager.getSessionId(),
    items,
    messages,
    inputs,
    turnUsage: projectTurnUsage(manager.getEntries()),
  };
}
