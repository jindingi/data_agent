import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProcessOutput } from '../../../src/node/process-output';
import { toolLimits } from '../../../src/shared/tool-limits';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function logPath() {
  const root = await mkdtemp(join(tmpdir(), 'output-capture-'));
  roots.push(root);
  return join(root, 'output.log');
}

it('does not create a log at or below the threshold and preserves head/tail after overflow', async () => {
  const path = await logPath();
  const output = new ProcessOutput({
    maxBytes: 2048,
    mode: 'head-tail',
    log: { path, budget: { remaining: toolLimits.runLogBytes } },
  });
  output.append(Buffer.from('a'.repeat(2048)));
  await expect(stat(path)).rejects.toThrow();
  output.append(Buffer.from('中'.repeat(1000) + 'END\n'));
  const result = await output.finish();
  expect(result.output).toContain('END\n');
  expect(result.output).not.toContain('\ufffd');
  expect(result.logComplete).toBe(true);
  expect(await readFile(path, 'utf8')).toBe('a'.repeat(2048) + '中'.repeat(1000) + 'END\n');
});

it('returns raw machine records without adding human-readable truncation text', async () => {
  const output = new ProcessOutput({ maxBytes: 10, mode: 'raw' });
  output.append(Buffer.from('one\0two\0three\0'));
  expect(await output.finish()).toEqual({ output: 'one\0two\0th', truncated: true });
});

it('bounds the pending log queue and reports the saved prefix as incomplete', async () => {
  const path = await logPath();
  const output = new ProcessOutput({
    maxBytes: 2048,
    mode: 'head-tail',
    log: { path, budget: { remaining: toolLimits.runLogBytes } },
  });
  output.append(Buffer.alloc(toolLimits.logQueueBytes + 1, 97));
  const result = await output.finish();
  expect(result.logComplete).toBe(false);
  expect(result.output).toContain('队列达到上限');
  expect(result.output).toContain('未保存本次输出日志');
  await expect(stat(path)).rejects.toThrow();
});
