import { open, mkdir, type FileHandle } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname } from 'node:path';
import { toolLimits } from '../shared/tool-limits';

export interface ProcessLogBudget {
  remaining: number;
}
interface Log {
  path: string;
  budget: ProcessLogBudget;
}

/** Bounded capture is independent of the optional overflow log and its disk quota. */
export class ProcessOutput {
  private head = Buffer.alloc(0);
  private tail = Buffer.alloc(0);
  private overflow = false;
  private log: OverflowLog | undefined;
  constructor(private options: { maxBytes: number; mode: 'head-tail' | 'raw'; log?: Log }) {
    if (options.log) this.log = new OverflowLog(options.log);
  }
  get truncated() {
    return this.overflow;
  }
  append(chunk: Buffer) {
    const available = this.options.maxBytes - this.head.length;
    if (!this.overflow && chunk.length > available) {
      this.overflow = true;
      this.log?.append(this.head);
    }
    if (this.overflow) this.log?.append(chunk);
    if (available > 0) this.head = Buffer.concat([this.head, chunk.subarray(0, available)]);
    if (this.options.mode === 'head-tail') {
      const tailBytes = Math.floor(this.options.maxBytes / 2);
      this.tail = Buffer.concat([this.tail, chunk.subarray(-tailBytes)]).subarray(-tailBytes);
    }
    return decodePrefix(this.head);
  }
  async finish() {
    await this.log?.finish();
    let output = decodePrefix(this.head, !this.overflow);
    if (this.overflow && this.options.mode === 'head-tail') {
      const head = decodePrefix(this.head.subarray(0, Math.ceil(this.options.maxBytes / 2)));
      let start = 0;
      while (start < this.tail.length && (this.tail[start] & 0xc0) === 0x80) start++;
      output = `${head}\n[…中间输出已省略…]\n${decodePrefix(this.tail.subarray(start), true)}`;
    }
    if (this.overflow && this.log) {
      output += `\n[输出已截断，仅返回头尾合计最多 ${this.options.maxBytes / 1024} KiB。]\n`;
      output += this.log.saved
        ? `日志路径：${this.log.path}\n可使用 read 的 byteOffset 按需读取日志。\n`
        : '未保存本次输出日志。\n';
      output += this.log.failed
        ? '日志写入失败，输出日志未完整保存。'
        : this.log.queueCut
          ? '日志写入队列达到上限，日志未完整保存。'
          : this.log.quotaCut
            ? '已达到每次任务合计 10 MiB 日志上限，日志未完整保存。'
            : 'stdout/stderr 已保存到日志；每次任务日志合计最多保留 10 MiB。';
    }
    return {
      output,
      truncated: this.overflow,
      ...(this.log && this.overflow
        ? {
            logBytes: this.log.saved,
            logComplete: !this.log.failed && !this.log.queueCut && !this.log.quotaCut,
            ...(this.log.saved ? { logPath: this.log.path } : {}),
          }
        : {}),
    };
  }
}

function decodePrefix(bytes: Buffer, final = false) {
  return new TextDecoder().decode(bytes, { stream: !final });
}

/** Single writer with bounded pending bytes; a gap stops further logging, preserving a prefix. */
class OverflowLog {
  saved = 0;
  failed = false;
  queueCut = false;
  quotaCut = false;
  private pendingBytes = 0;
  private tail = Promise.resolve();
  private file: FileHandle | undefined;
  constructor(private log: Log) {}
  get path() {
    return this.log.path;
  }
  append(chunk: Buffer) {
    if (this.failed || this.queueCut || this.quotaCut || !chunk.length) return;
    const part = chunk.subarray(0, this.log.budget.remaining);
    if (part.length < chunk.length) this.quotaCut = true;
    if (!part.length) return;
    if (this.pendingBytes + part.length > toolLimits.logQueueBytes) {
      this.queueCut = true;
      return;
    }
    this.log.budget.remaining -= part.length;
    this.pendingBytes += part.length;
    this.tail = this.tail.then(async () => {
      try {
        if (this.failed) return;
        if (!this.file) {
          await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
          this.file = await open(
            this.path,
            constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW,
            0o600,
          );
        }
        await this.file.writeFile(part);
        this.saved += part.length;
      } catch {
        this.failed = true;
      } finally {
        this.pendingBytes -= part.length;
      }
    });
  }
  async finish() {
    await this.tail;
    try {
      await this.file?.close();
    } catch {
      this.failed = true;
    }
  }
}
