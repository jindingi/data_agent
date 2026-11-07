import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { modelFixture } from '../../../scripts/test/model-fixture.mjs';
import { configure, submit, settled, rpc } from '../../support/desktop.mjs';

const gate = () => {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

const usage = (input, cached, output, reasoning = 0) => ({
  prompt_tokens: input + cached,
  completion_tokens: output,
  total_tokens: input + cached + output,
  prompt_cache_hit_tokens: cached,
  completion_tokens_details: { reasoning_tokens: reasoning },
});
export const cases = {
  async 'usage.queue-boundaries'({ dir }) {
    const fixture = await modelFixture();
    const app = await startApp(join(dir, 'usage-queues'), { testModelBaseUrl: fixture.baseUrl });
    const gates = [];
    try {
      const page = app.page;
      await configure(page);
      for (const kind of ['steer', 'followUp']) {
        const wait = gate();
        gates.push(wait);
        fixture.set(
          async () => {
            await wait.promise;
            return { tool: { name: 'ls', args: { path: '.' } }, usage: usage(10, 20, 30) };
          },
          { text: 'QUEUE_RESPONSE', usage: usage(100, 200, 300) },
          { text: 'FOLLOWUP_RESPONSE', usage: usage(1000, 2000, 3000) },
        );
        const before = fixture.requests.length;
        const id = await submit(page, `Initial ${kind}`);
        await until(() => fixture.requests.length > before, 'first request in flight');
        await page.getByLabel('运行中输入方式').selectOption(kind);
        await page.getByRole('textbox', { name: '分析需求' }).fill(`Queued ${kind}`);
        await page.getByRole('button', { name: '发送分析需求', exact: true }).click();
        await until(
          async () =>
            (await rpc(page, { type: 'runtime.snapshot', sessionId: id })).queuedInputs.length ===
            1,
          'queued input',
        );
        assert.equal(
          await page.getByRole('button', { name: '查看本轮用量', exact: true }).count(),
          0,
        );
        wait.release();
        const final = await settled(page, id);
        assert.equal(final.turnUsage.length, 2);
        assert.deepEqual(
          final.turnUsage.map((turn) => turn.totalTokens),
          kind === 'steer' ? [60, 600] : [660, 6000],
        );
        assert(final.turnUsage.every((turn) => turn.complete));
        assert.equal(final.turnUsage[0].status, 'continued');
        assert.equal(final.turnUsage[1].status, 'completed');
        assert.equal(
          await page.getByRole('button', { name: '查看本轮用量', exact: true }).count(),
          2,
        );
      }
      assert.deepEqual(app.errors, []);
      return { steer: true, followUp: true, queuedNotCounted: true };
    } finally {
      for (const wait of gates) wait.release();
      await app.stop();
      await fixture.close();
    }
  },
};
