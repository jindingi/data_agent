import { randomUUID } from 'node:crypto';
import type { Interaction, InteractionAnswer } from '../../shared/tools';
import { AppError } from '../../shared/errors';

export class InteractionBroker {
  private pending = new Map<
    string,
    {
      value: Interaction;
      resolve: (answer: InteractionAnswer) => void;
      reject: (error: Error) => void;
      cleanup: () => void;
    }
  >();
  request(
    value: Omit<Interaction, 'id'>,
    signal: AbortSignal,
    notify: (value: Interaction | null) => void,
  ) {
    signal.throwIfAborted();
    const interaction: Interaction = { ...value, id: randomUUID() };
    return new Promise<InteractionAnswer>((resolve, reject) => {
      const cancel = () => this.cancel(interaction.id);
      this.pending.set(interaction.id, {
        value: interaction,
        resolve,
        reject,
        cleanup: () => {
          signal.removeEventListener('abort', cancel);
          notify(null);
        },
      });
      signal.addEventListener('abort', cancel, { once: true });
      notify(interaction);
      if (signal.aborted) cancel();
    });
  }
  answer(
    binding: Pick<Interaction, 'id' | 'sessionId' | 'runId' | 'hostEpoch' | 'digest'>,
    answer: InteractionAnswer,
  ) {
    const pending = this.pending.get(binding.id);
    if (
      !pending ||
      ['sessionId', 'runId', 'hostEpoch', 'digest'].some(
        (key) => pending.value[key as keyof Interaction] !== binding[key as keyof typeof binding],
      ) ||
      pending.value.kind !== answer.kind
    )
      throw new AppError('INTERACTION_EXPIRED', '这项请求已结束或不匹配，操作没有再次执行');
    this.pending.delete(binding.id);
    pending.cleanup();
    pending.resolve(answer);
  }
  private cancel(id: string) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.cleanup();
    pending.reject(new AppError('CANCELLED', '交互已取消，未执行待批准操作'));
  }
  cancelRun(runId: string) {
    for (const item of this.pending.values())
      if (item.value.runId === runId) this.cancel(item.value.id);
  }
  stop() {
    for (const id of [...this.pending.keys()]) this.cancel(id);
  }
}
