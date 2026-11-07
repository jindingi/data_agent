import { expect, it } from 'vitest';
import { RunAdmission } from '../../../src/main/services/runtime/admission';
it('owns two permits, preserves FIFO and ignores releases of unrelated runs', () => {
  const queue = new RunAdmission<{ snapshot: { runId: string } }>(2);
  for (const runId of ['a', 'b', 'c']) queue.enqueue({ snapshot: { runId } });
  expect(queue.take()?.snapshot.runId).toBe('a');
  expect(queue.take()?.snapshot.runId).toBe('b');
  expect(queue.take()).toBeUndefined();
  queue.release('old');
  expect(queue.activeCount).toBe(2);
  queue.release('a');
  expect(queue.take()?.snapshot.runId).toBe('c');
  expect(queue.activeCount).toBe(2);
  queue.release('a');
  expect(queue.activeCount).toBe(2);
});
