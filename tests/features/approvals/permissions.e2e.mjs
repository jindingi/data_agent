import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { rpc, configure, submit, settled } from '../../support/desktop.mjs';
import { modelFixture } from '../../../scripts/test/model-fixture.mjs';

async function interaction(page, sessionId, kind = 'approval') {
  await page
    .getByRole('region', { name: kind === 'approval' ? '安全审批' : '澄清问题', exact: true })
    .waitFor({ timeout: 30_000 });
  return until(
    async () =>
      (await rpc(page, { type: 'runtime.snapshot', sessionId }))?.interactions?.find(
        (value) => value.kind === kind,
      ),
    'interaction in authoritative snapshot',
  );
}

async function late(page, value, changes = {}) {
  const response = await page.evaluate((command) => window.dataAgent.request(command), {
    type: 'interaction.answer',
    interactionId: value.id,
    sessionId: value.sessionId,
    runId: value.runId,
    digest: value.digest,
    answer: {
      kind: value.kind,
      ...(value.kind === 'approval' ? { decision: 'allow_once' } : { answer: 'late' }),
    },
    ...changes,
  });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'INTERACTION_EXPIRED');
}
export const cases = {
  async 'approvals.permissions'({ dir }) {
    const root = resolve(dir, 'p3-approval');
    mkdirSync(root, { recursive: true });
    const fixture = await modelFixture();
    let app;
    try {
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      let page = app.page;
      await configure(page);
      const operation = (target) => ({
        tool: { name: 'bash', args: { command: `printf approved >> ${JSON.stringify(target)}` } },
      });
      const allowed = join(root, 'allowed.txt');
      fixture.set(operation(allowed), { text: 'Approved once.' });
      let sessionId = await submit(page),
        pending = await interaction(page, sessionId);
      assert(!existsSync(allowed));
      await late(page, pending, { digest: '0'.repeat(64) });
      await late(page, pending, { runId: randomUUID() });
      await page.getByRole('button', { name: '允许这一次', exact: true }).click();
      assert.equal((await settled(page, sessionId)).state, 'completed');
      assert.equal(readFileSync(allowed, 'utf8'), 'approved');
      await late(page, pending);
      assert.equal(readFileSync(allowed, 'utf8'), 'approved');
      for (const action of ['deny', 'cancel', 'host_exit', 'close_reopen']) {
        const target = join(root, `${action}.txt`);
        fixture.set(operation(target), { text: 'Operation handled.' });
        sessionId = await submit(page);
        pending = await interaction(page, sessionId);
        assert(!existsSync(target));
        if (action === 'deny')
          await page.getByRole('button', { name: '拒绝', exact: true }).click();
        if (action === 'cancel')
          await page.getByRole('button', { name: '停止', exact: true }).click();
        if (action === 'host_exit')
          process.kill(
            await rpc(page, { type: 'automation.control', action: 'host_pid', sessionId }),
            'SIGKILL',
          );
        if (action === 'close_reopen') {
          const old = page;
          await rpc(page, { type: 'automation.control', action: 'close_reopen' });
          await until(() => old.isClosed(), 'native window actually closed');
          page = await until(
            () =>
              app.browser
                .contexts()[0]
                .pages()
                .find((value) => value !== old && !value.isClosed()),
            'native activate reopened window',
          );
          app.page = page;
          await page.getByRole('textbox', { name: '分析需求' }).waitFor();
          const restored = await interaction(page, sessionId);
          assert.equal(restored.id, pending.id);
          assert(!existsSync(target));
          await page.getByRole('button', { name: '允许这一次', exact: true }).click();
        }
        const final = await settled(page, sessionId);
        if (action === 'host_exit') assert.equal(final.state, 'interrupted');
        if (action === 'cancel') assert.equal(final.state, 'cancelled');
        await late(page, pending);
        assert.equal(existsSync(target), action === 'close_reopen');
        if (action === 'close_reopen') assert.equal(readFileSync(target, 'utf8'), 'approved');
      }
      const deleteTarget = join(root, 'keep.txt');
      writeFileSync(deleteTarget, 'keep');
      fixture.set(
        { tool: { name: 'bash', args: { command: `rm ${JSON.stringify(deleteTarget)}` } } },
        { text: 'Deletion declined.' },
      );
      sessionId = await submit(page);
      await interaction(page, sessionId);
      await page.getByRole('button', { name: '拒绝', exact: true }).click();
      await settled(page, sessionId);
      assert.equal(readFileSync(deleteTarget, 'utf8'), 'keep');
      // A file modified while waiting cannot reuse approval for its old content.
      const changedTarget = join(root, 'changed-target.txt'),
        script = join(root, 'change.py');
      writeFileSync(
        script,
        `from pathlib import Path\nPath(${JSON.stringify(changedTarget)}).write_text('before')\n`,
      );
      fixture.set(
        { tool: { name: 'bash', args: { command: `python3 ${JSON.stringify(script)}` } } },
        { text: 'Changed script rejected.' },
      );
      sessionId = await submit(page);
      pending = await interaction(page, sessionId);
      writeFileSync(script, readFileSync(script, 'utf8').replace('before', 'after'));
      await page.getByRole('button', { name: '允许这一次', exact: true }).click();
      const changed = await settled(page, sessionId);
      assert(changed.tools.some((tool) => tool.output.includes('已变化')));
      assert(!existsSync(changedTarget));
      const quitTarget = join(root, 'quit.txt');
      fixture.set(operation(quitTarget), { text: 'Must not run.' });
      sessionId = await submit(page);
      await interaction(page, sessionId);
      await page.screenshot({ path: join(root, 'approval.png'), fullPage: true });
      await rpc(page, { type: 'automation.control', action: 'quit' });
      await app.exit;
      await app.stop();
      app = undefined;
      assert(!existsSync(quitTarget));
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      page = app.page;
      assert.equal(await page.getByRole('region', { name: '安全审批' }).count(), 0);
      assert(!existsSync(quitTarget));
      assert.deepEqual(app.errors, []);
      return {
        allowOnce: true,
        deniedNoWrite: true,
        cancellation: true,
        hostExit: true,
        windowCloseReopen: true,
        quit: true,
        staleBindingRejected: true,
        scriptHashRechecked: true,
        actualHttpRequests: fixture.requests.length,
      };
    } finally {
      await app?.stop();
      await fixture.close();
    }
  },
};
