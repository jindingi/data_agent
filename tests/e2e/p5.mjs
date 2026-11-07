import { selectSession } from '../support/desktop.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { join, resolve } from 'node:path';
import { startApp, until } from '../../scripts/test/harness.mjs';
import { runFollowup } from '../../scripts/eval/run-followup.mjs';
import { modelFixture } from '../../scripts/test/model-fixture.mjs';
import { rpc, configure, submit, settled } from '../support/desktop.mjs';

async function send(page, text, kind) {
  if (kind) await page.getByLabel('运行中输入方式').selectOption(kind);
  await page.getByRole('textbox', { name: '分析需求' }).fill(text);
  await page.getByRole('button', { name: '发送分析需求', exact: true }).click();
  await until(
    () =>
      page
        .getByRole('textbox', { name: '分析需求' })
        .inputValue()
        .then((value) => value === ''),
    'input accepted',
  );
}
async function runningTool(page, sessionId) {
  return until(async () => {
    const s = await rpc(page, { type: 'runtime.snapshot', sessionId });
    return s?.tools.some((t) => t.name === 'bash' && t.status === 'running') ? s : null;
  }, 'real tool started');
}
async function listing(page, sessionId, count) {
  return until(async () => {
    const value = await rpc(page, { type: 'artifacts.list', sessionId });
    return value.versions.length === count && value.versions.every((v) => v.state === 'published')
      ? value
      : null;
  }, 'all versions published');
}
const writeReport = (content) => ({
  tool: { name: 'write', args: { path: 'report.md', content } },
});
const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const barrier = {
  name: 'bash',
  args: { command: 'while [ ! -f release ]; do sleep 0.1; done; printf first > report.md' },
};
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
  'P5-LIVE-RESUME': ({ dir }) => runFollowup(join(dir, 'p5-live-resume')),
  'P5-SWITCH': ({ dir }) => concurrentLifecycle(dir),
  'P5-WINDOW': ({ dir }) => concurrentLifecycle(dir),
  async 'P5-RETRY-COMPACT'({ dir }) {
    const root = resolve(dir, 'p5-retry-compact'),
      fixture = await modelFixture();
    let app;
    try {
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      const page = app.page;
      await configure(page);
      fixture.set(
        { status: 400, error: 'overloaded: synthetic temporary provider failure' },
        {
          text: 'Recovered after real SDK retry.',
          delay: 800,
          usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
        },
      );
      const retryId = await submit(page, 'Exercise the SDK retry lifecycle.');
      await page.locator('[data-runtime-activity="retry"]').waitFor({ timeout: 15_000 });
      const retrying = await rpc(page, { type: 'runtime.snapshot', sessionId: retryId });
      assert.equal(retrying.state, 'running');
      assert.equal(retrying.activity.attempt, 1);
      const retried = await settled(page, retryId);
      assert.equal(retried.state, 'completed');
      assert.equal(retried.error, null);
      assert.equal(retried.turnUsage[0].totalTokens, 60);
      assert.equal(retried.turnUsage[0].calls, 2);
      assert.equal(retried.turnUsage[0].complete, false, 'failed request had no usage');
      assert.equal(fixture.requests.length, 2);
      fixture.set(
        { status: 400, error: 'overloaded: stop during retry' },
        { text: 'This retry must not run.' },
      );
      const cancelRetryId = await submit(page, 'Cancel the SDK while it waits to retry.');
      await page.locator('[data-runtime-activity="retry"]').waitFor({ timeout: 15_000 });
      const beforeCancel = fixture.requests.length;
      await page.getByRole('button', { name: '停止', exact: true }).click();
      const cancelled = await settled(page, cancelRetryId);
      assert.equal(cancelled.state, 'cancelled');
      assert.equal(cancelled.error, null);
      assert.equal(cancelled.activity, null);
      await delay(250);
      assert.equal(fixture.requests.length, beforeCancel);
      fixture.set(
        {
          text:
            'PRE_COMPACTION_MARKER\n' + 'Long synthetic context for real compaction. '.repeat(3000),
          usage: { prompt_tokens: 4_000_000, completion_tokens: 100, total_tokens: 4_000_100 },
        },
        {
          text: 'COMPACTED_FIXTURE_MEMORY: user requested synthetic history.',
          delay: 1500,
          usage: { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 },
        },
      );
      const compactId = await submit(page, 'Create enough synthetic history to compact.');
      await page.locator('[data-runtime-activity="compaction"]').waitFor({ timeout: 15_000 });
      assert.equal(
        (await rpc(page, { type: 'runtime.snapshot', sessionId: compactId })).state,
        'running',
      );
      const compacted = await settled(page, compactId);
      assert.equal(compacted.state, 'completed');
      assert.equal(compacted.turnUsage[0].totalTokens, 4_000_160);
      assert.equal(compacted.turnUsage[0].compactions, 1);
      assert.equal(compacted.turnUsage[0].complete, true);
      const records = readFileSync(join(root, 'data/sessions', `${compactId}.jsonl`), 'utf8')
        .trim()
        .split('\n')
        .map(JSON.parse);
      assert(
        records.some(
          (e) => e.type === 'compaction' && e.summary.includes('COMPACTED_FIXTURE_MEMORY'),
        ),
      );
      assert(
        compacted.messages.some((m) =>
          m.blocks.some((b) => b.type === 'text' && b.text.includes('PRE_COMPACTION_MARKER')),
        ),
      );
      fixture.set({ text: 'Continued after compaction.' });
      await send(page, 'Continue using the compacted history.');
      await until(async () => {
        const x = await rpc(page, { type: 'runtime.snapshot', sessionId: compactId });
        return x?.runId !== compacted.runId && x?.state === 'completed';
      }, 'continued after compaction');
      assert(JSON.stringify(fixture.requests.at(-1).messages).includes('COMPACTED_FIXTURE_MEMORY'));
      await page.getByText('PRE_COMPACTION_MARKER', { exact: false }).first().waitFor();
      assert.deepEqual(app.errors, []);
      return {
        retryVisibleUntilSettled: true,
        cancelDuringRetryIsCancelled: true,
        actualNativeCompactionEntry: true,
        fullHistoryRetained: true,
        compactedContextUsed: true,
      };
    } finally {
      await app?.stop();
      await fixture.close();
    }
  },
  async 'P5-STOP'({ dir }) {
    const root = resolve(dir, 'p5-stop'),
      fixture = await modelFixture();
    let app;
    try {
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      const page = app.page;
      await configure(page);
      for (const kind of ['tool', 'approval', 'clarification']) {
        const operation =
          kind === 'tool'
            ? barrier
            : kind === 'approval'
              ? {
                  name: 'write',
                  args: { path: join(root, 'never-write.txt'), content: 'not approved' },
                }
              : {
                  name: 'ask_clarification',
                  args: { question: 'Choose a fixture option.', options: ['one', 'two'] },
                };
        fixture.set({ tool: operation }, { text: 'Must not be called after stop.' });
        const sessionId = await submit(page, `Stop while waiting for ${kind}.`);
        await until(async () => {
          const s = await rpc(page, { type: 'runtime.snapshot', sessionId });
          return kind === 'tool'
            ? s?.tools.some((t) => t.status === 'running')
            : s?.interactions?.length;
        }, 'pending work');
        await send(page, 'Unconsumed followup remains unsent.', 'followUp');
        const before = fixture.requests.length;
        await page.getByRole('button', { name: '停止', exact: true }).click();
        const final = await settled(page, sessionId);
        assert.equal(final.state, 'cancelled');
        assert.equal(final.inputs.find((i) => i.kind === 'followUp').state, 'cancelled');
        assert(final.unsentInputs.some((i) => i.text === 'Unconsumed followup remains unsent.'));
        assert.deepEqual(final.interactions, []);
        await delay(250);
        assert.equal(fixture.requests.length, before);
        assert(!existsSync(join(root, 'never-write.txt')));
        await page.getByText('未发送 · 后续提问', { exact: true }).waitFor();
      }
      const requestsBeforeRestart = fixture.requests.length;
      await app.stop();
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      const sessions = await rpc(app.page, { type: 'sessions.list' });
      for (const session of sessions) {
        const restored = await rpc(app.page, { type: 'runtime.snapshot', sessionId: session.id });
        assert.equal(restored.unsentInputs.length, 1);
        assert.equal(restored.unsentInputs[0].text, 'Unconsumed followup remains unsent.');
        assert(!restored.unsentInputs.some((i) => i.kind === 'prompt'));
      }
      assert.equal(fixture.requests.length, requestsBeforeRestart);
      return {
        toolApprovalClarificationCancelled: true,
        queueNotExecuted: true,
        unsentVisible: true,
        unsentRecoveredAfterQuit: true,
        committedDraftRemoved: true,
      };
    } finally {
      await app?.stop();
      await fixture.close();
    }
  },
  async 'P5-CRASH'({ dir }) {
    const results = [];
    for (const target of ['host', 'main']) {
      const root = resolve(dir, `p5-crash-${target}`),
        fixture = await modelFixture();
      let app;
      try {
        app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
        await configure(app.page);
        const child =
          "import time\nf=open('heartbeat.txt','a',buffering=1)\nwhile True: f.write('tick\\n'); time.sleep(.05)\n";
        const worker =
          "import os,json,subprocess,sys,time\nchild=subprocess.Popen([sys.executable,'child.py'])\nwith open('pids.json','w') as f: json.dump([os.getpid(),child.pid],f)\nwith open('report.md','w') as f: f.write('# Partial delivery before crash')\ntime.sleep(120)\n";
        fixture.set(
          { tool: { name: 'write', args: { path: 'child.py', content: child } } },
          { tool: { name: 'write', args: { path: 'worker.py', content: worker } } },
          { tool: { name: 'bash', args: { command: 'python3 worker.py' } } },
          { text: 'Must not replay after crash.' },
        );
        const sessionId = await submit(app.page, 'Start a controlled process tree.');
        await app.page.getByRole('button', { name: '允许这一次', exact: true }).waitFor();
        const pending = (await rpc(app.page, { type: 'runtime.snapshot', sessionId }))
          .interactions[0];
        await app.page.getByRole('button', { name: '允许这一次', exact: true }).click();
        const live = await until(async () => {
          const s = await rpc(app.page, { type: 'runtime.snapshot', sessionId });
          return s?.outputDirectory &&
            existsSync(join(s.outputDirectory, 'pids.json')) &&
            existsSync(join(s.outputDirectory, 'heartbeat.txt'))
            ? s
            : null;
        }, 'worker and descendant running');
        const pids = JSON.parse(readFileSync(join(live.outputDirectory, 'pids.json'), 'utf8'));
        assert.equal(pids.length, 2);
        await send(app.page, 'Uncertain input must not automatically repeat.', 'followUp');
        const requestCount = fixture.requests.length,
          start = Date.now();
        if (target === 'host')
          process.kill(
            await rpc(app.page, { type: 'automation.control', action: 'host_pid', sessionId }),
            'SIGKILL',
          );
        else {
          app.child.kill('SIGKILL');
          await app.exit;
        }
        await until(
          () =>
            pids.every((pid) => {
              try {
                process.kill(pid, 0);
                return false;
              } catch {
                return true;
              }
            }),
          'process tree reaped',
          5000,
        );
        const reapedMs = Date.now() - start,
          size = statSync(join(live.outputDirectory, 'heartbeat.txt')).size;
        await delay(10_000);
        assert.equal(statSync(join(live.outputDirectory, 'heartbeat.txt')).size, size);
        if (target === 'host')
          assert.equal((await settled(app.page, sessionId)).state, 'interrupted');
        await app.stop();
        app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
        const recovered = await rpc(app.page, { type: 'runtime.snapshot', sessionId });
        assert.equal(recovered.state, 'interrupted');
        assert.equal(recovered.runId, live.runId);
        assert.equal(recovered.inputs.find((i) => i.kind === 'prompt').state, 'committed');
        assert.equal(recovered.inputs.find((i) => i.kind === 'followUp').state, 'unknown');
        assert(recovered.messages.some((m) => m.role === 'user'));
        assert.deepEqual(recovered.interactions, []);
        const outputs = await listing(app.page, sessionId, 1);
        assert(outputs.files.some((f) => f.relativePath === 'report.md' && f.size > 0));
        const answer = await app.page.evaluate((command) => window.dataAgent.request(command), {
          type: 'interaction.answer',
          interactionId: pending.id,
          sessionId,
          runId: pending.runId,
          hostEpoch: pending.hostEpoch,
          digest: pending.digest,
          answer: { kind: 'approval', decision: 'allow_once' },
        });
        assert.equal(answer.ok, false);
        assert.equal(answer.error.code, 'INTERACTION_EXPIRED');
        assert.equal(fixture.requests.length, requestCount);
        await selectSession(app.page, sessionId);
        await app.page.locator('[data-run-state="interrupted"]').waitFor();
        assert.equal(
          await app.page.locator('.tool-card small').filter({ hasText: '执行中' }).count(),
          0,
        );
        assert.equal(recovered.unsentInputs.length, 1);
        assert.equal(
          recovered.unsentInputs[0].text,
          'Uncertain input must not automatically repeat.',
        );
        await app.page.getByRole('button', { name: '放回输入框', exact: true }).click();
        await until(
          async () =>
            (await app.page.getByRole('textbox', { name: '分析需求' }).inputValue()) ===
            'Uncertain input must not automatically repeat.',
          'unconsumed input restored after metadata inspection',
        );
        fixture.set({ text: 'An explicitly sent new prompt after recovery.' });
        await send(app.page, 'A new explicit prompt, not a replay.');
        await until(async () => {
          const s = await rpc(app.page, { type: 'runtime.snapshot', sessionId });
          return s?.runId !== live.runId && s?.state === 'completed';
        }, 'fresh run after recovery');
        const next = await rpc(app.page, { type: 'runtime.snapshot', sessionId });
        assert.equal(next.unsentInputs.length, 1);
        assert.equal(next.unsentInputs[0].inputId, recovered.unsentInputs[0].inputId);
        const other = await rpc(app.page, { type: 'sessions.create' });
        const cross = await app.page.evaluate((command) => window.dataAgent.request(command), {
          type: 'runtime.discardDraft',
          sessionId: other.id,
          inputId: recovered.unsentInputs[0].inputId,
        });
        assert.equal(cross.ok, false);
        await app.page.getByRole('button', { name: '移除未发送输入', exact: true }).click();
        await until(
          () =>
            app.page
              .locator('[data-unsent-input]')
              .count()
              .then((n) => n === 0),
          'discarded draft disappears',
        );
        assert.deepEqual(
          (await rpc(app.page, { type: 'runtime.snapshot', sessionId })).unsentInputs,
          [],
        );
        results.push({
          target,
          reapedMs,
          stableHeartbeatMs: 10000,
          recoveredWithoutReplay: true,
          partialReportVisible: true,
          unsentTextRecoveredAndScoped: true,
        });
      } finally {
        await app?.stop();
        await fixture.close();
      }
    }
    return results;
  },
  async 'P5-MULTITURN'({ dir }) {
    const root = resolve(dir, 'p5-multiturn'),
      fixture = await modelFixture();
    let app;
    try {
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      const page = app.page;
      await configure(page);
      fixture.set(writeReport('# First report'), { text: 'First delivery complete.' });
      const sessionId = await submit(page, 'Create first report.'),
        first = await settled(page, sessionId);
      assert.equal(first.state, 'completed');
      const before = await listing(page, sessionId, 1),
        old = before.files.find((f) => f.relativePath === 'report.md');
      fixture.set(writeReport('# Second report'), { text: 'Second delivery complete.' });
      await send(page, 'Continue from previous delivery and create a new report.');
      const second = await until(async () => {
        const s = await rpc(page, { type: 'runtime.snapshot', sessionId });
        return s?.runId !== first.runId && s?.state === 'completed' ? s : null;
      }, 'second run completed');
      const after = await listing(page, sessionId, 2),
        reports = after.files.filter((f) => f.relativePath === 'report.md');
      assert.notEqual(second.runId, first.runId);
      assert.equal(reports.length, 2);
      assert.equal(readFileSync(old.path, 'utf8'), '# First report');
      assert.equal(after.files.find((f) => f.id === old.id).sha256, old.sha256);
      assert.equal(
        readFileSync(join(second.outputDirectory, 'report.md'), 'utf8'),
        '# Second report',
      );
      assert(
        fixture.requests
          .at(-1)
          .messages.some(
            (m) => m.role === 'user' && JSON.stringify(m.content).includes('Create first report.'),
          ),
      );
      assert.equal(second.messages.filter((m) => m.role === 'user').length, 2);
      await page.screenshot({ path: join(root, 'multiturn.png'), fullPage: true });
      assert.deepEqual(app.errors, []);
      return { distinctRuns: true, historyInActualRequest: true, priorArtifactPreserved: true };
    } finally {
      await app?.stop();
      await fixture.close();
    }
  },
  async 'P5-STEER'({ dir }) {
    const root = resolve(dir, 'p5-steer'),
      fixture = await modelFixture();
    let app;
    try {
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      const page = app.page;
      await configure(page);
      let output;
      fixture.set(
        {
          tools: [
            barrier,
            { name: 'write', args: { path: 'batch-second.txt', content: 'second' } },
          ],
        },
        (payload) => {
          assert.equal(readFileSync(join(output, 'report.md'), 'utf8'), 'first');
          assert.equal(readFileSync(join(output, 'batch-second.txt'), 'utf8'), 'second');
          assert.equal(payload.messages.filter((m) => m.role === 'tool').length, 2);
          assert(
            payload.messages.some(
              (m) => m.role === 'user' && JSON.stringify(m.content).includes('steer-after-batch'),
            ),
          );
          return { text: 'Steering consumed after both tools.' };
        },
      );
      const sessionId = await submit(page, 'Run two tools as one batch.');
      const active = await runningTool(page, sessionId);
      output = active.outputDirectory;
      await send(page, 'steer-after-batch', 'steer');
      assert.equal(fixture.requests.length, 1);
      assert(!existsSync(join(output, 'batch-second.txt')));
      writeFileSync(join(output, 'release'), 'release');
      const final = await settled(page, sessionId);
      assert.equal(final.state, 'completed');
      assert.equal(
        final.inputs.filter((i) => i.kind === 'steer' && i.state === 'committed').length,
        1,
      );
      assert.equal(final.outputDirectory, output);
      return { batchCompletedBeforeSteer: true, steerCommittedOnce: true, sameOutputVersion: true };
    } finally {
      await app?.stop();
      await fixture.close();
    }
  },
  async 'P5-FOLLOWUP'({ dir }) {
    const root = resolve(dir, 'p5-followup'),
      fixture = await modelFixture();
    let app;
    try {
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      const page = app.page;
      await configure(page);
      fixture.set(
        { tool: barrier },
        { text: 'First finished.' },
        writeReport('# Followup 1'),
        { text: 'Followup 1 finished.' },
        writeReport('# Followup 2'),
        { text: 'Followup 2 finished.' },
      );
      const sessionId = await submit(page, 'Start then wait for followups.'),
        active = await runningTool(page, sessionId);
      await send(page, 'same followup text', 'followUp');
      await send(page, 'same followup text', 'followUp');
      const queued = await rpc(page, { type: 'runtime.snapshot', sessionId });
      assert.equal(queued.queuedInputs.filter((i) => i.kind === 'followUp').length, 2);
      writeFileSync(join(active.outputDirectory, 'release'), 'release');
      const final = await settled(page, sessionId);
      assert.equal(final.state, 'completed');
      assert.equal(final.runId, active.runId);
      const followups = final.inputs.filter((i) => i.kind === 'followUp');
      assert.equal(followups.length, 2);
      assert(followups.every((i) => i.state === 'committed'));
      assert.equal(new Set(followups.map((i) => i.entryId)).size, 2);
      assert.equal(
        final.messages.filter(
          (m) =>
            m.role === 'user' &&
            m.blocks.some((b) => b.type === 'text' && b.text === 'same followup text'),
        ).length,
        2,
      );
      assert.deepEqual(final.queuedInputs, []);
      const outputs = await listing(page, sessionId, 3),
        reports = outputs.files.filter((f) => f.relativePath === 'report.md');
      assert.deepEqual(reports.map((f) => readFileSync(f.path, 'utf8')).sort(), [
        '# Followup 1',
        '# Followup 2',
        'first',
      ]);
      assert.equal(new Set(reports.map((f) => f.path)).size, 3);
      assert.equal(fixture.requests.length, 6);
      assert.equal(fixture.requests[2].messages.filter((m) => m.role === 'user').length, 2);
      assert.equal(fixture.requests[4].messages.filter((m) => m.role === 'user').length, 3);
      const paths = fixture.requests
        .filter((_, i) => [0, 2, 4].includes(i))
        .map((p) => JSON.stringify(p.messages.filter((m) => m.role === 'system')));
      assert(
        paths[1].includes(
          reports
            .find((f) => readFileSync(f.path, 'utf8') === '# Followup 1')
            .path.replace('/report.md', ''),
        ),
      );
      assert(
        paths[2].includes(
          reports
            .find((f) => readFileSync(f.path, 'utf8') === '# Followup 2')
            .path.replace('/report.md', ''),
        ),
      );
      await page.screenshot({ path: join(root, 'followup.png'), fullPage: true });
      assert.deepEqual(app.errors, []);
      return {
        sameRun: true,
        distinctInputIds: true,
        consumedOnceInOrder: true,
        threePreservedVersions: true,
      };
    } finally {
      await app?.stop();
      await fixture.close();
    }
  },
};
