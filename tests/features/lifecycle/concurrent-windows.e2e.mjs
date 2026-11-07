import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { join, resolve } from 'node:path';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { modelFixture } from '../../../scripts/test/model-fixture.mjs';
import { rpc, configure, submit, settled } from '../../support/desktop.mjs';

async function runningTool(page, sessionId) {
  return until(async () => {
    const s = await rpc(page, { type: 'runtime.snapshot', sessionId });
    return s?.tools.some((t) => t.name === 'bash' && t.status === 'running') ? s : null;
  }, 'real tool started');
}

const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";

const lifecycleRuns = new Map();

async function concurrentLifecycle(dir) {
  if (lifecycleRuns.has(dir)) return lifecycleRuns.get(dir);
  const task = (async () => {
    const root = resolve(dir, 'p5-concurrent-window'),
      fixture = await modelFixture();
    let app;
    try {
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      let page = app.page;
      await configure(page);
      const outside = join(root, 'approval-must-not-write.txt');
      const code =
        "import time\nf=open('heartbeat.txt','a',buffering=1)\nfor _ in range(1200): f.write('tick\\n'); time.sleep(.1)\n";
      fixture.set(
        { tool: { name: 'write', args: { path: outside, content: 'requires approval' } } },
        { tool: { name: 'bash', args: { command: `python3 -c ${shellQuote(code)}` } } },
        {
          tool: {
            name: 'ask_clarification',
            args: { question: 'C clarification must stay paused.', options: ['one', 'two'] },
          },
        },
        { text: 'No cancelled run should request this.' },
      );
      const a = await submit(page, 'SESSION_A_MARKER');
      await rpc(page, { type: 'sessions.rename', sessionId: a, title: 'A approval' });
      const approval = await until(async () => {
        const s = await rpc(page, { type: 'runtime.snapshot', sessionId: a });
        return s?.interactions?.[0];
      }, 'A approval');
      const b = await submit(page, 'SESSION_B_MARKER');
      await rpc(page, { type: 'sessions.rename', sessionId: b, title: 'B heartbeat' });
      const bLive = await runningTool(page, b);
      const heartbeat = join(bLive.outputDirectory, 'heartbeat.txt');
      await until(() => existsSync(heartbeat) && statSync(heartbeat).size > 0, 'B heartbeat');
      const c = await submit(page, 'SESSION_C_MARKER');
      await rpc(page, { type: 'sessions.rename', sessionId: c, title: 'C queued' });
      assert.equal((await rpc(page, { type: 'runtime.snapshot', sessionId: c })).state, 'queued');
      assert.equal(fixture.requests.length, 2);
      for (const [name, status] of [
        ['A approval', 'waiting_approval'],
        ['B heartbeat', 'running'],
        ['C queued', 'queued'],
      ])
        await page
          .getByRole('button', { name: `打开会话 ${name}`, exact: true })
          .locator(`[data-session-activity="${status}"]`)
          .waitFor();
      assert.equal(await page.getByRole('region', { name: '安全审批', exact: true }).count(), 0);
      await page.getByRole('button', { name: '打开会话 A approval', exact: true }).click();
      await page.getByRole('region', { name: '安全审批', exact: true }).waitFor();
      const old = page;
      await rpc(page, { type: 'automation.control', action: 'close_reopen' });
      await until(() => old.isClosed(), 'last window closed');
      const size = statSync(heartbeat).size;
      page = await until(
        () =>
          app.browser
            .contexts()[0]
            .pages()
            .find((p) => p !== old && !p.isClosed()),
        'native activate reopened',
      );
      app.page = page;
      await page.getByRole('textbox', { name: '分析需求' }).waitFor();
      await until(() => statSync(heartbeat).size > size, 'B continues while window closed');
      await page
        .getByRole('button', { name: '打开会话 A approval', exact: true })
        .locator('[data-session-activity="waiting_approval"]')
        .waitFor();
      await page
        .getByRole('button', { name: '打开会话 B heartbeat', exact: true })
        .locator('[data-session-activity="running"]')
        .waitFor();
      const reopened = await rpc(page, { type: 'runtime.snapshot', sessionId: a });
      assert.equal(reopened.interactions[0].id, approval.id);
      assert(!existsSync(outside));
      await page.getByRole('button', { name: '打开会话 A approval', exact: true }).click();
      await page.getByRole('button', { name: '停止', exact: true }).click();
      assert.equal((await settled(page, a)).state, 'cancelled');
      const cPending = await until(async () => {
        const x = await rpc(page, { type: 'runtime.snapshot', sessionId: c });
        return x?.interactions?.[0];
      }, 'C gets released permit');
      assert.equal(cPending.kind, 'clarification');
      assert.equal((await rpc(page, { type: 'runtime.snapshot', sessionId: b })).state, 'running');
      await page.getByRole('button', { name: '打开会话 B heartbeat', exact: true }).click();
      assert.equal(await page.getByRole('region', { name: '安全审批', exact: true }).count(), 0);
      assert.equal(await page.getByRole('region', { name: '澄清问题', exact: true }).count(), 0);
      for (const [id, marker] of [
        [a, 'SESSION_A_MARKER'],
        [b, 'SESSION_B_MARKER'],
        [c, 'SESSION_C_MARKER'],
      ]) {
        const s = await rpc(page, { type: 'runtime.snapshot', sessionId: id });
        const text = JSON.stringify(s.messages.filter((m) => m.role === 'user'));
        assert(text.includes(marker));
        for (const other of ['SESSION_A_MARKER', 'SESSION_B_MARKER', 'SESSION_C_MARKER'].filter(
          (m) => m !== marker,
        ))
          assert(!text.includes(other));
      }
      const d = await submit(page, 'GLOBAL_QUEUE_UNSENT_PROMPT');
      assert.equal((await rpc(page, { type: 'runtime.snapshot', sessionId: d })).state, 'queued');
      const count = fixture.requests.length;
      await rpc(page, { type: 'automation.control', action: 'quit' });
      await app.exit;
      await app.stop();
      app = undefined;
      const stoppedSize = statSync(heartbeat).size;
      await delay(300);
      assert.equal(statSync(heartbeat).size, stoppedSize);
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      page = app.page;
      for (const id of [a, b, c]) {
        const s = await rpc(page, { type: 'runtime.snapshot', sessionId: id });
        assert.equal(s.state, 'cancelled');
        assert.deepEqual(s.interactions, []);
      }
      const draft = await rpc(page, { type: 'runtime.snapshot', sessionId: d });
      assert.equal(draft.state, 'cancelled');
      assert.equal(draft.unsentInputs.length, 1);
      assert.equal(draft.unsentInputs[0].text, 'GLOBAL_QUEUE_UNSENT_PROMPT');
      assert.equal(draft.messages.length, 0);
      assert.equal(fixture.requests.length, count);
      assert(!existsSync(outside));
      for (const id of [a, b, c]) {
        const rows = readFileSync(join(root, 'data/sessions', `${id}.jsonl`), 'utf8')
          .trim()
          .split('\n')
          .map(JSON.parse);
        const entryIds = rows.filter((e) => e.id).map((e) => e.id);
        assert.equal(new Set(entryIds).size, entryIds.length);
      }
      return {
        twoActiveThirdQueued: true,
        noCrossSessionState: true,
        stopAReleasesCWithoutStoppingB: true,
        windowClosePreservesApprovalAndBExecution: true,
        quitCancelsAll: true,
        restartDoesNotReplay: true,
        queuedPromptRecovered: true,
      };
    } finally {
      await app?.stop();
      await fixture.close();
    }
  })();
  lifecycleRuns.set(dir, task);
  return task;
}
export const cases = {
  'lifecycle.concurrent-windows': ({ dir }) => concurrentLifecycle(dir),
};
