import type { ToolService } from '../tools';
import type { ArtifactService } from '../artifacts';
/** Terminal cleanup owns writer ordering; permits are released only when this settles. */
export class RunLifecycle {
  private pending = new Set<Promise<void>>();
  constructor(private dependencies: { tools: ToolService; artifacts: ArtifactService }) {}
  finish(
    runId: string,
    versionId: string | undefined,
    writers: (Promise<unknown> | undefined)[],
    done: () => void,
  ) {
    const task = (async () => {
      await Promise.allSettled(writers);
      await this.dependencies.tools.settled(runId);
      try {
        if (versionId) await this.dependencies.artifacts.publish(versionId);
      } finally {
        this.dependencies.tools.releaseRun(runId);
      }
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
