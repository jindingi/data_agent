import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
export const cases = {
  async 'conversation.retry-compaction'({ dir }) {
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
};
