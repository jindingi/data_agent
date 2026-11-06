import { dirname } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { inspectSessionFile } from '../node/session-integrity';
import { AppError } from '../shared/errors';
import type { HistoryItem } from '../shared/models';

/** Only the Host owns native session access; preflight must succeed before open(). */
export function readHistory(file: string, workspace: string, expectedId: string) {
  const inspected = inspectSessionFile(file, expectedId, true);
  if (inspected.state !== 'persisted') throw new AppError('HISTORY_UNAVAILABLE', inspected.error || '会话历史不可用');
  const manager = SessionManager.open(file, dirname(file), workspace);
  const items: HistoryItem[] = [];
  for (const entry of manager.getBranch()) {
    if (entry.type !== 'message') continue;
    const message = entry.message;
    const content = 'content' in message ? message.content : '';
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(b => b.type === 'text').map(b => b.text).join('\n') : '';
    items.push({ id: entry.id, role: message.role, text });
  }
  return { piSessionId: manager.getSessionId(), items };
}
