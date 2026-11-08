/** Transport request count and active-time budget; human waiting does not consume active time. */
export class RequestBudget {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private since: number | undefined;
  private remaining: number;
  private count = 0;
  constructor(
    private requestLimit = 50,
    milliseconds = 10 * 60_000,
  ) {
    this.remaining = milliseconds;
  }
  get requests() {
    return this.count;
  }
  consume() {
    if (this.count >= this.requestLimit)
      throw new Error(`已达到本次任务的 ${this.requestLimit} 次模型请求上限。`);
    this.count++;
  }
  pause() {
    clearTimeout(this.timer);
    if (this.since !== undefined) this.remaining -= Date.now() - this.since;
    this.since = undefined;
  }
  resume(expired: () => void) {
    if (this.since !== undefined) return;
    this.since = Date.now();
    this.timer = setTimeout(expired, Math.max(1, this.remaining));
  }
}
