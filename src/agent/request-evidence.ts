import { createHash } from 'node:crypto';
import type { RuntimeSnapshot } from '../shared/runtime';
export function requestEvidence(payload: unknown, known: ReadonlySet<string>) {
  const p = payload as {
    model?: unknown;
    messages?: { role?: string; content?: unknown; reasoning_content?: unknown }[];
    tools?: { function?: { name?: string } }[];
    thinking?: { type?: string };
    reasoning_effort?: string;
  };
  const messages = Array.isArray(p.messages) ? p.messages : [];
  const evidence: NonNullable<RuntimeSnapshot['requests']>[number] = {
    model: typeof p.model === 'string' ? p.model : '',
    toolNames: p.tools?.flatMap((tool) => (tool.function?.name ? [tool.function.name] : [])) ?? [],
    userMessages: messages.filter((message) => message.role === 'user').length,
    toolResultHashes: messages
      .filter((message) => message.role === 'tool')
      .map((message) =>
        createHash('sha256')
          .update(
            typeof message.content === 'string'
              ? message.content
              : (JSON.stringify(message.content) ?? ''),
          )
          .digest('hex'),
      ),
    hasReasoning: messages.some((message) => typeof message.reasoning_content === 'string'),
    hasNonemptyReasoning: messages.some(
      (message) =>
        typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0,
    ),
    hasInternalEnvelope: [...known].some((id) =>
      JSON.stringify(messages).includes(`[data-agent-input:${id}]`),
    ),
    thinkingEnabled: p.thinking?.type === 'enabled',
    reasoningEffort: p.reasoning_effort ?? '',
  };
  return evidence;
}
