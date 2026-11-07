/** FIFO with explicit permits; a late completion cannot release another run's permit. */
export class RunAdmission<T extends { snapshot: { runId: string } }> {
  private queue: T[] = [];
  private permits = new Set<string>();
  constructor(private capacity = 2) {}
  enqueue(task: T) {
    this.queue.push(task);
  }
  take() {
    if (this.permits.size >= this.capacity) return;
    const task = this.queue.shift();
    if (task) this.permits.add(task.snapshot.runId);
    return task;
  }
  release(runId: string) {
    this.permits.delete(runId);
  }
  remove(runId: string) {
    this.queue = this.queue.filter((task) => task.snapshot.runId !== runId);
  }
  get activeCount() {
    return this.permits.size;
  }
  get queuedCount() {
    return this.queue.length;
  }
}
