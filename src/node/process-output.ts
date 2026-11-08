import { appendFileSync, closeSync, constants, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ProcessLogBudget {
  remaining: number;
}

/** Bounded preview; spill the entire observed output only after the threshold is crossed. */
export class ProcessOutput {
  private prefix = Buffer.alloc(0);
  private overflow = false;
  private saved = 0;
  private logCut = false;
  private logFailed = false;
  private limit: number;

  constructor(private log?: { path: string; budget: ProcessLogBudget }) {
    // Search tools keep their existing output bound, without process-log persistence.
    this.limit = log ? 2 * 1024 : 60 * 1024;
  }

  get truncated() {
    return this.overflow;
  }

  append(chunk: Buffer) {
    const available = this.limit - this.prefix.length;
    if (!this.overflow && chunk.length > available) {
      this.overflow = true;
      this.save(this.prefix);
    }
    if (this.overflow) this.save(chunk);
    if (available > 0) this.prefix = Buffer.concat([this.prefix, chunk.subarray(0, available)]);
    return this.preview();
  }

  private save(chunk: Buffer) {
    if (!this.log || !chunk.length || this.logFailed) return;
    const part = chunk.subarray(0, this.log.budget.remaining);
    if (part.length < chunk.length) this.logCut = true;
    if (!part.length) return;
    try {
      if (!this.saved) mkdirSync(dirname(this.log.path), { recursive: true, mode: 0o700 });
      const file = openSync(
        this.log.path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        // Reserve before writing: a partial write followed by an error must not exceed the quota.
        this.log.budget.remaining -= part.length;
        appendFileSync(file, part);
      } finally {
        closeSync(file);
      }
      this.saved += part.length;
    } catch {
      this.logFailed = true;
    }
  }

  private preview(final = false) {
    // A boundary in the middle of a UTF-8 character must not introduce a replacement character.
    return new TextDecoder().decode(this.prefix, { stream: !final || this.overflow });
  }

  finish() {
    const text = this.preview(true);
    if (!this.overflow) return text;
    if (!this.log) return text + '\n[输出已截断。]';
    const notice = this.logFailed
      ? '日志写入失败，输出日志未完整保存。'
      : this.logCut
        ? '已达到每次任务合计 10 MiB 日志上限，日志未完整保存。'
        : 'stdout/stderr 已保存到日志；每次任务日志合计最多保留 10 MiB。';
    return (
      text +
      '\n[输出已截断，仅返回前 2 KiB。]\n' +
      (this.saved
        ? `日志路径：${this.log.path}\n可使用 read 按需读取日志。\n`
        : '未保存本次输出日志。\n') +
      notice
    );
  }
}
