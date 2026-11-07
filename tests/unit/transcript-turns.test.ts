import { expect, it } from 'vitest';
import { transcriptTurns } from '../../src/renderer/features/runtime/transcript-turns';
import type { MessageView } from '../../src/shared/runtime';
it('keeps all model/tool steps in the user turn and preserves steer/follow-up boundaries', () => {
  const message = (id: string, role: string): MessageView => ({
    id,
    role,
    blocks: [{ type: 'text', text: id }],
  });
  const history = [
    message('system', 'system'),
    message('u1', 'user'),
    message('a1', 'assistant'),
    message('tool', 'toolResult'),
    message('a2', 'assistant'),
    message('steer', 'user'),
    message('a3', 'assistant'),
    message('follow-up', 'user'),
    message('a4', 'assistant'),
  ];
  const turns = transcriptTurns(history);
  expect(turns.map((turn) => [turn.id, turn.replies.map((m) => m.id)])).toEqual([
    ['u1', ['a1', 'a2']],
    ['steer', ['a3']],
    ['follow-up', ['a4']],
  ]);
  expect(transcriptTurns([message('restored', 'assistant')])[0].id).toBe('restored');
  expect(transcriptTurns(history).slice(-1)[0].replies).toEqual([history.at(-1)]);
  const live = { ...message('live-id', 'user'), inputId: 'stable-input-id' };
  expect(transcriptTurns([live])[0].id).toBe(transcriptTurns([{ ...live, id: 'jsonl-id' }])[0].id);
});
