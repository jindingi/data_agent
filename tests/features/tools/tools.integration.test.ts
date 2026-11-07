import { beforeEach, afterEach, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../../../src/main/storage/database';
import { SessionService } from '../../../src/main/services/sessions';
import { InteractionBroker } from '../../../src/main/services/interactions';
import { ToolService, type ToolContext } from '../../../src/main/services/tools';
import { ensureAppPaths, getAppPaths } from '../../../src/node/app-paths';
import { getRuntimePaths } from '../../../src/node/runtime-paths';
import type { Interaction, ToolOperation } from '../../../src/shared/tools';

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
    command: 'python3 -c \'print("x" * (12*1024*1024))\'',
  });
  expect(first.isError).toBe(false);
  expect(first.output).toContain('截断');
  expect(Buffer.byteLength(first.output)).toBeLessThan(64 * 1024);
  expect(
    (await execute({ name: 'bash', command: 'python3 -c \'print("y" * 100000)\'' })).isError,
  ).toBe(false);
  const { readdirSync } = await import('node:fs');
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
}, 15_000);

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
