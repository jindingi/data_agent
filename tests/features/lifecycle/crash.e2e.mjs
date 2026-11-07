import { workspaceFiles } from '../../support/desktop.mjs';
import { selectSession } from '../../support/desktop.mjs';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { join, resolve } from 'node:path';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { modelFixture } from '../../../scripts/test/model-fixture.mjs';
import { rpc, configure, submit, settled } from '../../support/desktop.mjs';

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

async function listing(page, sessionId) {
  return until(async () => {
    const files = await workspaceFiles(page, sessionId);
    return files.length ? files : null;
  }, 'workspace files available');
}
export const cases = {
  async 'lifecycle.crash'({ dir }) {
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
        assert(outputs.some((f) => f.relativePath === 'report.md' && f.size > 0));
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
};
