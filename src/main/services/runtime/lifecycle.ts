import type { ToolService } from '../tools';
/** Terminal cleanup owns writer ordering; permits are released only when this settles. */
export class RunLifecycle {
  private pending = new Set<Promise<void>>();
  constructor(private dependencies: { tools: ToolService }) {}
  finish(runId: string, writers: (Promise<unknown> | undefined)[], done: () => void) {
    const task = (async () => {
      await Promise.allSettled(writers);
      await this.dependencies.tools.settled(runId);
      this.dependencies.tools.releaseRun(runId);
    })().finally(() => {
      this.pending.delete(task);
      done();
    });
    this.pending.add(task);
    // Errors remain on task for explicit callers; prevent an unobserved rejection on event delivery.
    void task.catch(() => {});
    return task;
  }
  async settled() {
    await Promise.allSettled([...this.pending]);
  }
}
