import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  statSync,
  readdirSync,
  unlinkSync,
  symlinkSync,
  mkdirSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../../src/main/storage/database';
import { SessionService } from '../../../src/main/services/sessions';
import { InteractionBroker } from '../../../src/main/services/interactions';
import { ToolService, type ToolContext } from '../../../src/main/services/tools';
import { ensureAppPaths, getAppPaths } from '../../../src/node/app-paths';
import { getRuntimePaths } from '../../../src/node/runtime-paths';
import type { Interaction, ToolOperation } from '../../../src/shared/tools';
import { toolLogPath } from '../../../src/node/tool-log-path';

let root: string, db: ReturnType<typeof openDatabase>, tools: ToolService, context: ToolContext;

const resources = getRuntimePaths(process.cwd(), '', false);

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(test: () => boolean, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (!test()) {
    if (Date.now() > end) throw new Error('Tool condition timed out');
    await delay(25);
  }
}

function answer(value: Interaction, allow = true) {
  tools.broker.answer(
    value,
    value.kind === 'approval'
      ? { kind: 'approval', decision: allow ? 'allow_once' : 'deny' }
      : { kind: 'clarification', answer: allow ? 'structured test answer' : null },
  );
}

function execute(
  operation: ToolOperation,
  interact: (value: Interaction) => void = (value) => answer(value),
) {
  return tools.execute(context, randomUUID(), operation, {
    output: () => {},
    interaction: (value) => {
      if (value) interact(value);
    },
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'data-agent-tools-'));
  const paths = getAppPaths(
    { DATA_AGENT_HOME: join(root, 'data'), DATA_AGENT_USER_DATA: join(root, 'user') },
    true,
  );
  ensureAppPaths(paths);
  db = openDatabase(paths.database);
  const session = new SessionService(db, paths).create();
  const runId = randomUUID();
  tools = new ToolService(resources, paths.logs, new InteractionBroker());
  context = {
    sessionId: session.id,
    runId,
    hostPid: process.pid,
    workspace: session.workspace,
    protectedRoots: [paths.sessions, paths.database, paths.logs],
    inputs: [],
  };
});

afterEach(() => {
  tools.stop();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

it('tools.execution seven generic tools use actual files, bundled search and Python', async () => {
  expect(
    (await execute({ name: 'write', path: '中文 目录/hello.txt', content: 'alpha\n华北,100\n' }))
      .isError,
  ).toBe(false);
  expect(
    (await execute({ name: 'read', path: '中文 目录/hello.txt', offset: 2, limit: 1 })).output,
  ).toContain('华北,100');
  expect(
    (
      await execute({
        name: 'edit',
        path: '中文 目录/hello.txt',
        oldText: 'alpha',
        newText: 'beta',
      })
    ).isError,
  ).toBe(false);
  expect(
    (
      await execute({
        name: 'edit',
        path: '中文 目录/hello.txt',
        oldText: 'absent',
        newText: 'bad',
      })
    ).isError,
  ).toBe(true);
  expect((await execute({ name: 'grep', path: '.', pattern: '华北' })).output).toContain(
    '华北,100',
  );
  expect((await execute({ name: 'find', path: '.', pattern: 'hello' })).output).toContain(
    'hello.txt',
  );
  expect((await execute({ name: 'ls', path: '中文 目录' })).output).toContain('f hello.txt');
  const source =
    "from pathlib import Path\nimport os, json, pandas, numpy, matplotlib.pyplot as plt, seaborn\nplt.plot([1,2],[2,1]); plt.title('中文图表'); plt.savefig('图表.png'); plt.close()\nPath('report.md').write_text('# Test report\\n', encoding='utf-8')\nprint(json.dumps({'python':os.sys.executable,'credentialInherited':'P3_SECRET_SENTINEL' in os.environ,'pandas':pandas.__version__}))\n";
  expect((await execute({ name: 'write', path: 'analysis.py', content: source })).isError).toBe(
    false,
  );
  process.env.P3_SECRET_SENTINEL = 'synthetic-only-do-not-inherit';
  let result;
  try {
    result = await execute({ name: 'bash', command: 'python3 analysis.py' });
  } finally {
    delete process.env.P3_SECRET_SENTINEL;
  }
  expect(result.isError, result.output).toBe(false);
  expect(result.output).toContain('"credentialInherited": false');
  expect(result.output).toContain('runtime/darwin-arm64/python');
  expect(result.output).not.toMatch(/Glyph .* missing/);
  expect(statSync(join(context.workspace, '图表.png')).size).toBeGreaterThan(100);
  expect(readFileSync(join(context.workspace, 'report.md'), 'utf8')).toBe('# Test report\n');
  const noisy = await execute({ name: 'bash', command: 'python3 -c "print(\'x\'*100000)"' });
  expect(noisy.isError).toBe(false);
  expect(noisy.output).toContain('截断');
  expect(Buffer.byteLength(noisy.output)).toBeLessThan(64 * 1024);
}, 30_000);

it('tools.cancellation abort reaps a real worker and descendant; heartbeat stays stopped for ten seconds', async () => {
  const heartbeat = join(context.workspace, 'heartbeat.txt');
  const source =
    "import subprocess,sys,time\ncode=\"import time; f=open('heartbeat.txt','a',buffering=1)\\nwhile True: f.write('tick\\\\n'); time.sleep(.05)\"\nchild=subprocess.Popen([sys.executable,'-c',code]); print(child.pid,flush=True); time.sleep(60)\n";
  writeFileSync(join(context.workspace, 'worker.py'), source);
  const operation = execute({ name: 'bash', command: 'python3 worker.py' });
  await until(() => existsSync(heartbeat) && statSync(heartbeat).size > 0);
  const start = Date.now();
  tools.cancelRun(context.runId);
  const result = await operation;
  expect(Date.now() - start).toBeLessThan(5000);
  expect(result.isError).toBe(true);
  for (const pid of [Number(result.details?.pid), Number(result.output.split('\n')[0])]) {
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
  }
  const size = statSync(heartbeat).size;
  await delay(10_000);
  expect(statSync(heartbeat).size).toBe(size);
}, 25_000);

it('tools.output-limit stops actual oversized output processes and blocks further growth without deleting files', async () => {
  const source =
    "import time\nwith open('large.bin','wb') as f: f.truncate(500*1024*1024+1)\nwhile True: time.sleep(.1)\n";
  expect((await execute({ name: 'write', path: 'large.py', content: source })).isError).toBe(false);
  const started = Date.now(),
    result = await execute({ name: 'bash', command: 'python3 large.py' });
  expect(Date.now() - started).toBeLessThan(5000);
  expect(result.isError).toBe(true);
  expect(result.output).toContain('500 MiB');
  expect(result.details?.reason).toBe('output_limit');
  expect(statSync(join(context.workspace, 'large.bin')).size).toBe(500 * 1024 * 1024 + 1);
  const rejected = await execute({ name: 'write', path: 'more.txt', content: 'must not write' });
  expect(rejected.isError).toBe(true);
  expect(rejected.output).toContain('500 MiB');
  expect(existsSync(join(context.workspace, 'more.txt'))).toBe(false);
  const shrink = await execute({
    name: 'write',
    path: 'large.bin',
    content: 'explicit replacement',
  });
  expect(shrink.isError, shrink.output).toBe(false);
  expect((await execute({ name: 'bash', command: 'printf recovered' })).isError).toBe(false);
}, 15_000);

it('tools.log-limit retains at most 10 MiB across actual tools in one run with bounded UI output', async () => {
  const first = await execute({
    name: 'bash',
    command: 'python3 -c \'print("x" * (6*1024*1024), end="")\'',
  });
  expect(first.isError).toBe(false);
  expect(first.output).toContain('截断');
  expect(first.output).toContain('日志路径：');
  expect(first.output).not.toContain('日志未完整保存');
  expect(Buffer.byteLength(first.output)).toBeLessThan(4096);
  const second = await execute({
    name: 'bash',
    command: 'python3 -c \'print("y" * (6*1024*1024), end="")\'',
  });
  expect(second.isError).toBe(false);
  expect(second.output).toContain('日志路径：');
  expect(second.output).toContain('日志未完整保存');
  const third = await execute({ name: 'bash', command: 'python3 -c \'print("z" * 100000)\'' });
  expect(third.isError).toBe(false);
  expect(third.output).toContain('未保存本次输出日志');
  expect(third.output).not.toContain('日志路径：');
  const logDir = join(root, 'data/logs', context.sessionId);
  expect(
    readdirSync(logDir).reduce(
      (sum, folder) =>
        sum +
        readdirSync(join(logDir, folder)).reduce(
          (total, file) => total + statSync(join(logDir, folder, file)).size,
          0,
        ),
      0,
    ),
  ).toBe(10 * 1024 * 1024);
  expect(readdirSync(logDir)).toHaveLength(2);
}, 15_000);

it('tools.log-storage saves only bash overflow, keeps both streams and lets the Agent read only its session logs', async () => {
  const logs = join(root, 'data/logs');
  for (const bytes of [0, 500, 2048]) {
    const result = await execute({
      name: 'bash',
      command: `python3 -c 'print("x" * ${bytes}, end="")'`,
    });
    expect(result.isError, result.output).toBe(false);
    expect(result.output).toBe('x'.repeat(bytes));
    expect(readdirSync(logs)).toEqual([]);
  }
  const boundary = await execute({
    name: 'bash',
    command: 'python3 -c \'print("b" * 2049, end="")\'',
  });
  const boundaryPath = boundary.output.match(/日志路径：([^\n]+)/)?.[1];
  expect(boundaryPath).toBeTruthy();
  expect(readFileSync(boundaryPath!, 'utf8')).toBe('b'.repeat(2049));
  const id = randomUUID();
  const streamed: string[] = [];
  const result = await tools.execute(
    context,
    id,
    {
      name: 'bash',
      command:
        'python3 -c \'import sys,time; print("a" * 2047, end="", flush=True); time.sleep(.1); print("中文_END", end="", file=sys.stderr)\'',
    },
    {
      output: (text) => streamed.push(text),
      interaction: (value) => {
        if (value) answer(value);
      },
    },
  );
  expect(result.isError, result.output).toBe(false);
  const path = toolLogPath(logs, context.sessionId, context.runId, id);
  const expected = 'a'.repeat(2047) + '中文_END';
  expect(readFileSync(path, 'utf8')).toBe(expected);
  expect(result.output).toContain('日志路径：' + path);
  expect(result.output.split('\n')[0]).toBe('a'.repeat(1024));
  expect(result.output).toContain('中文_END');
  expect(result.details?.logComplete).toBe(true);
  expect(result.output).not.toContain('\ufffd');
  expect(
    streamed.every((value) => Buffer.byteLength(value) <= 2048 && !value.includes('\ufffd')),
  ).toBe(true);
  const read = await execute({ name: 'read', path });
  expect(read.isError, read.output).toBe(false);
  expect(read.output).toBe(expected);

  // The hint remains usable on the next run; no in-memory grant or persisted manifest.
  const previous = context.runId;
  tools.releaseRun(previous);
  context.runId = randomUUID();
  expect((await execute({ name: 'read', path })).output).toBe(expected);
  const denied = await tools.execute(
    { ...context, sessionId: randomUUID() },
    randomUUID(),
    {
      name: 'read',
      path,
    },
    { output: () => {}, interaction: () => {} },
  );
  expect(denied.isError).toBe(true);
  expect(denied.output).not.toContain('中文_END');
  expect((await execute({ name: 'write', path, content: 'must not write' })).isError).toBe(true);
  unlinkSync(path);
  const secret = join(context.workspace, '.env');
  writeFileSync(secret, 'SYNTHETIC_LOG_REDIRECTION_SECRET');
  symlinkSync(secret, path);
  const redirected = await execute({ name: 'read', path });
  expect(redirected.isError).toBe(true);
  expect(redirected.output).not.toContain('SYNTHETIC_LOG_REDIRECTION_SECRET');

  // Redirect after the read exception is granted but before policy resolves the file.
  unlinkSync(path);
  writeFileSync(path, expected);
  const otherPath = toolLogPath(logs, randomUUID(), randomUUID(), 'other-session');
  mkdirSync(dirname(otherPath), { recursive: true });
  writeFileSync(otherPath, 'OTHER_SESSION_LOG_SECRET');
  const inspect = tools.policy.inspect.bind(tools.policy);
  const swap = vi.spyOn(tools.policy, 'inspect').mockImplementationOnce(async (...args) => {
    unlinkSync(path);
    symlinkSync(otherPath, path);
    return inspect(...args);
  });
  try {
    const raced = await execute({ name: 'read', path });
    expect(raced.isError).toBe(true);
    expect(raced.output).not.toContain('OTHER_SESSION_LOG_SECRET');
  } finally {
    swap.mockRestore();
  }

  const failed = await execute({
    name: 'bash',
    command: 'python3 -c \'import sys; print("ERR" * 1000, file=sys.stderr); sys.exit(7)\'',
  });
  expect(failed.isError).toBe(true);
  expect(failed.output).toContain('退出码：7');
  const failedPath = failed.output.match(/日志路径：([^\n]+)/)?.[1];
  expect(failedPath).toBeTruthy();
  expect(readFileSync(failedPath!, 'utf8')).toBe('ERR'.repeat(1000) + '\n');

  const blockedLogRoot = join(context.workspace, 'not-a-directory');
  writeFileSync(blockedLogRoot, 'synthetic failure');
  const failedLogger = new ToolService(resources, blockedLogRoot, new InteractionBroker());
  try {
    const delivered = await failedLogger.execute(
      context,
      randomUUID(),
      {
        name: 'bash',
        command: 'python3 -c \'print("still succeeds" * 300)\'',
      },
      { output: () => {}, interaction: () => {} },
    );
    expect(delivered.isError, delivered.output).toBe(false);
    expect(delivered.output).toContain('日志写入失败');
    expect(delivered.output).not.toContain('日志路径：');
  } finally {
    failedLogger.stop();
  }
}, 20_000);

it('tools.resource-release repeated settled runs release tool registries and process log budgets', async () => {
  for (let i = 0; i < 5; i++) {
    context.runId = randomUUID();
    const result = await execute({ name: 'bash', command: "printf 'resource-test'" });
    expect(result.isError).toBe(false);
    tools.cancelRun(context.runId);
    expect((await execute({ name: 'ls', path: context.workspace })).isError).toBe(true);
    await tools.settled(context.runId);
    tools.releaseRun(context.runId);
    expect(tools.resourceCounts()).toEqual({ active: 0, tails: 0, closed: 0, processBudgets: 0 });
  }
});

it('tools.search-pagination finds later matches and pages complete long paths with explicit bounds', async () => {
  writeFileSync(
    join(context.workspace, 'matches.txt'),
    Array.from({ length: 160 }, (_, i) => `MATCH_${i + 1}`).join('\n') + '\n',
  );
  const first = await execute({ name: 'grep', path: 'matches.txt', pattern: 'MATCH_', limit: 30 });
  expect(first.isError, first.output).toBe(false);
  expect(first.details?.nextOffset).toBe(30);
  expect(first.output).toContain('offset=30');
  const next = await execute({
    name: 'grep',
    path: 'matches.txt',
    pattern: 'MATCH_',
    limit: 30,
    offset: 30,
  });
  expect(next.output).toContain('MATCH_31');
  expect(next.output).toContain('MATCH_60');
  const normal = await execute({ name: 'grep', path: 'matches.txt', pattern: 'MATCH_' });
  expect(normal.output).toContain('MATCH_100');
  expect(normal.details?.nextOffset).toBe(100);

  const dir = join(context.workspace, 'long');
  mkdirSync(dir);
  const names = Array.from({ length: 300 }, (_, i) => String(i).padStart(4, '0') + 'x'.repeat(240));
  for (const name of names) writeFileSync(join(dir, name), '');
  for (const name of ['find', 'ls'] as const) {
    const found: string[] = [];
    let offset = 0;
    for (let page = 0; page < 5; page++) {
      const result = await execute(
        name === 'find'
          ? { name, path: 'long', pattern: '', offset }
          : { name, path: 'long', offset },
      );
      expect(result.isError, result.output).toBe(false);
      expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(64 * 1024);
      const lines = result.output.split('\n[')[0].split('\n');
      found.push(...lines.map((line) => (name === 'ls' ? line.slice(2) : line)));
      if (result.details?.nextOffset === undefined) break;
      expect(result.details.nextOffset).toBeGreaterThan(offset);
      offset = result.details.nextOffset;
    }
    expect(found).toEqual(names);
  }
  expect(readdirSync(join(root, 'data/logs'))).toEqual([]);
}, 20_000);

it('tools.log-continuation reads a saved long line beyond 8 MiB without broadening log access', async () => {
  const path = toolLogPath(join(root, 'data/logs'), context.sessionId, context.runId, 'long-log');
  mkdirSync(dirname(path), { recursive: true });
  const offset = 9 * 1024 * 1024;
  writeFileSync(path, 'a'.repeat(offset) + 'TAIL_AFTER_9_MIB\n');
  const result = await execute({ name: 'read', path, byteOffset: offset });
  expect(result.isError, result.output).toBe(false);
  expect(result.output).toBe('TAIL_AFTER_9_MIB\n');
  expect((await execute({ name: 'grep', path, pattern: 'TAIL' })).isError).toBe(true);
  const denied = await tools.execute(
    { ...context, sessionId: randomUUID() },
    randomUUID(),
    { name: 'read', path, byteOffset: offset },
    { output() {}, interaction() {} },
  );
  expect(denied.isError).toBe(true);
  expect(denied.output).not.toContain('TAIL_AFTER_9_MIB');
});
