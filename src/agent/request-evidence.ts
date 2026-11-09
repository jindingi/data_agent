import { createHash } from 'node:crypto';
import type { RuntimeSnapshot } from '../shared/runtime';
export function requestEvidence(payload: unknown, known: ReadonlySet<string>) {
  const p = payload as {
    model?: unknown;
    messages?: { role?: string; content?: unknown; reasoning_content?: unknown }[];
    input?: {
      role?: string;
      type?: string;
      output?: unknown;
      content?: unknown;
      reasoning_content?: unknown;
    }[];
    tools?: { name?: string; function?: { name?: string } }[];
    thinking?: { type?: string };
    reasoning_effort?: string;
    reasoning?: { effort?: string };
  };
  const messages = Array.isArray(p.messages) ? p.messages : (p.input ?? []);
  const evidence: NonNullable<RuntimeSnapshot['requests']>[number] = {
    model: typeof p.model === 'string' ? p.model : '',
    toolNames:
      p.tools?.flatMap((tool) =>
        tool.function?.name || tool.name ? [tool.function?.name ?? tool.name!] : [],
      ) ?? [],
    userMessages: messages.filter((message) => message.role === 'user').length,
    toolResultHashes: messages
      .filter(
        (message) =>
          message.role === 'tool' || ('type' in message && message.type === 'function_call_output'),
      )
      .map((message) =>
        createHash('sha256')
          .update(
            typeof ('output' in message ? message.output : message.content) === 'string'
              ? String('output' in message ? message.output : message.content)
              : (JSON.stringify('output' in message ? message.output : message.content) ?? ''),
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
    reasoningEffort: p.reasoning_effort ?? p.reasoning?.effort ?? '',
  };
  return evidence;
}
