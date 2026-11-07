import type { MessageView } from '../../../shared/runtime';

export interface TranscriptTurn {
  id: string;
  user?: MessageView;
  replies: MessageView[];
}

/** Group the projection only. Never rewrite native history or equate a tool step with a user turn. */
export function transcriptTurns(messages: MessageView[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const message of messages) {
    if (message.role === 'toolResult' || message.role === 'system' || !message.blocks.length)
      continue;
    // Live message IDs become native JSONL entry IDs at settle; inputId remains stable.
    if (message.role === 'user')
      turns.push({ id: message.inputId ?? message.id, user: message, replies: [] });
    else {
      if (!turns.length) turns.push({ id: message.id, replies: [] });
      turns[turns.length - 1].replies.push(message);
    }
  }
  return turns;
}
