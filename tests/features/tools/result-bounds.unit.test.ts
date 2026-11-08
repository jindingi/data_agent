import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readText } from '../../../src/node/read-text';
import { ToolOperations } from '../../../src/main/services/tool-operations';
import { getRuntimePaths } from '../../../src/node/runtime-paths';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'tool-result-bounds-')));
  roots.push(workspace);
  return workspace;
}

it.each(['中', '🙂中\ufeffx'])(
  'continues a long UTF-8 line without repeating or skipping bytes (%s)',
  async (characters) => {
    const workspace = await fixture();
    const text = characters.repeat(30_000) + '\nEND\n';
    await writeFile(join(workspace, 'long.txt'), text);
    let byteOffset = 0;
    let combined = '';
    for (let page = 0; page < 10; page++) {
      const result = await readText(workspace, [], { path: 'long.txt', byteOffset });
      combined += result.output.split('\n[读取已截断')[0];
      const next = result.details?.nextByteOffset;
      if (next === undefined) break;
      expect(next).toBeGreaterThan(byteOffset);
      byteOffset = next;
    }
    expect(combined).toBe(text);
  },
);

it('reads a byte range beyond the line-scanning budget', async () => {
  const workspace = await fixture();
  const offset = 8 * 1024 * 1024;
  await writeFile(join(workspace, 'large.txt'), 'x'.repeat(offset) + 'AFTER_SCAN_LIMIT\n');
  const result = await readText(workspace, [], {
    path: 'large.txt',
    byteOffset: offset,
  });
  expect(result.output).toBe('AFTER_SCAN_LIMIT\n');
});

it('bounds directory results by bytes and supplies a continuation position', async () => {
  const workspace = await fixture();
  await mkdir(join(workspace, 'files'));
  for (let i = 0; i < 500; i++)
    await writeFile(join(workspace, 'files', String(i).padStart(4, '0') + 'x'.repeat(240)), '');
  const context = {
    workspace,
    sessionId: randomUUID(),
    runId: randomUUID(),
    hostPid: process.pid,
    protectedRoots: [],
    inputs: [],
  };
  const operations = new ToolOperations(getRuntimePaths(process.cwd(), '', false), {
    run: async () => {
      throw new Error('ls must not launch a child process');
    },
  });
  const result = await operations.execute(
    context,
    'list',
    { name: 'ls', path: 'files' },
    new AbortController().signal,
    { output() {}, interaction() {} },
    join(workspace, 'files'),
  );
  expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(64 * 1024);
  expect(result.details?.nextOffset).toBeGreaterThan(0);
});
