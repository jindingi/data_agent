import type { MessageEndEvent } from '@earendil-works/pi-coding-agent';
import { boundToolResult } from '../node/tool-output';

/** Cap a newly completed result before native persistence, including SDK validation errors. */
export function boundNewToolResult(
  message: MessageEndEvent['message'],
  maxBytes: number,
): MessageEndEvent['message'] {
  if (message.role !== 'toolResult') return message;
  const output = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  if (Buffer.byteLength(output) <= maxBytes) return message;
  const bounded = boundToolResult({ output, isError: message.isError }, maxBytes);
  return {
    ...message,
    content: [{ type: 'text', text: bounded.output }],
    details: {
      ...(message.details && typeof message.details === 'object' ? message.details : {}),
      ...bounded.details,
    },
  };
}
