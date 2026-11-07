import { createHash } from 'node:crypto';
import { join } from 'node:path';
export function sessionLogDirectory(root: string, sessionId: string) {
  if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(sessionId))
    throw new Error('Invalid log identity');
  return join(root, sessionId);
}
export function toolLogDirectory(root: string, sessionId: string, toolCallId: string) {
  return join(
    sessionLogDirectory(root, sessionId),
    createHash('sha256').update(toolCallId).digest('hex'),
  );
}
export function toolLogPath(root: string, sessionId: string, runId: string, toolCallId: string) {
  sessionLogDirectory(root, runId);
  return join(toolLogDirectory(root, sessionId, toolCallId), `${runId}.log`);
}
