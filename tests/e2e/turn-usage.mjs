import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { startApp, until } from '../../scripts/test/harness.mjs';
import { modelFixture } from '../../scripts/test/model-fixture.mjs';
import { configure, submit, settled, rpc } from '../support/desktop.mjs';

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
  async 'P5-USAGE-RECOVERY'({ dir }) {
    const fixture = await modelFixture(),
      pending = gate();
    const root = join(dir, 'usage-recovery');
    let app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
    try {
      let page = app.page;
      await configure(page);
      fixture.set(
        { tool: { name: 'ls', args: { path: '.' } }, usage: usage(10, 20, 30) },
        async () => {
          await pending.promise;
          return { text: 'not delivered' };
        },
        { text: 'CONCURRENT_USAGE', usage: usage(100, 200, 300) },
      );
      const a = await submit(page, 'Interrupted session A');
      await until(() => fixture.requests.length === 2, 'A second request in flight');
      const b = await submit(page, 'Concurrent session B');
      const bFinal = await settled(page, b);
      assert.equal(bFinal.turnUsage[0].totalTokens, 600);
      const pid = await rpc(page, { type: 'automation.control', action: 'host_pid', sessionId: a });
      process.kill(pid, 'SIGKILL');
      const aFinal = await settled(page, a);
      assert.equal(aFinal.state, 'interrupted');
      assert.equal(aFinal.turnUsage[0].totalTokens, 60);
      assert.equal(aFinal.turnUsage[0].complete, false);
      assert.equal(aFinal.turnUsage[0].status, 'interrupted');
      pending.release();
      assert.deepEqual(
        (await rpc(page, { type: 'runtime.snapshot', sessionId: b })).turnUsage,
        bFinal.turnUsage,
      );
      await app.stop();
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      page = app.page;
      const restoredA = await rpc(page, { type: 'runtime.snapshot', sessionId: a });
      assert.deepEqual(restoredA.turnUsage, aFinal.turnUsage);
      assert.deepEqual(
        (await rpc(page, { type: 'runtime.snapshot', sessionId: b })).turnUsage,
        bFinal.turnUsage,
      );
      assert.equal(fixture.requests.length, 3, 'restart does not repeat model requests');
      assert.deepEqual(app.errors, []);
      return { concurrentIsolation: true, hostCrash: true, restart: true, noReplay: true };
    } finally {
      pending.release();
      await app.stop();
      await fixture.close();
    }
  },

  async 'UX-TURN-USAGE'({ dir }) {
    const fixture = await modelFixture(),
      stop = gate();
    const root = join(dir, 'turn-usage');
    let app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
    try {
      let page = app.page;
      await configure(page);
      fixture.set(
        { tool: { name: 'ls', args: { path: '.' } }, usage: usage(378, 4984, 372, 16) },
        { text: 'USAGE_FINAL', usage: usage(1000, 5000, 2000, 1000) },
      );
      const id = await submit(page, 'Usage fixture');
      const first = await settled(page, id);
      assert.equal(first.turnUsage.length, 1);
      assert.deepEqual(
        { ...first.turnUsage[0], models: undefined, inputId: undefined },
        {
          input: 1378,
          output: 2372,
          cacheRead: 9984,
          cacheWrite: 0,
          reasoning: 1016,
          totalTokens: 13734,
          inputId: undefined,
          status: 'completed',
          complete: true,
          calls: 2,
          compactions: 0,
          models: undefined,
        },
      );
      const button = page.getByRole('button', { name: '查看本轮用量', exact: true }).first();
      await button.waitFor();
      assert((await button.innerText()).includes('13.7K'));
      await button.focus();
      await page.keyboard.press('Enter');
      let popup = page.getByRole('dialog', { name: '本轮用量详情', exact: true });
      await popup.waitFor();
      const text = await popup.innerText();
      for (const value of [
        '13,734 tok',
        '87.9%',
        '1,378 tok',
        '9,984 tok',
        '2,372 tok',
        '1,016 tok',
        'deepseek / deepseek-flash',
        '2 次',
      ])
        assert(text.includes(value), value);
      assert.equal(await page.locator('.execution-process .usage-trigger').count(), 0);
      await page.screenshot({ path: join(dir, 'usage-dark.png') });
      await page.keyboard.press('Escape');
      assert(
        await button.evaluate((node) => document.activeElement === node),
        'Escape returns focus',
      );
      await page.getByRole('button', { name: '切换到浅色模式', exact: true }).click();
      for (const [width, height] of [
        [1440, 900],
        [1024, 768],
        [800, 640],
      ]) {
        await page.setViewportSize({ width, height });
        await button.click();
        popup = page.getByRole('dialog', { name: '本轮用量详情', exact: true });
        const box = await popup.boundingBox();
        assert(
          box &&
            box.x >= 0 &&
            box.y >= 0 &&
            box.x + box.width <= width &&
            box.y + box.height <= height,
        );
        await page.screenshot({ path: join(dir, `usage-light-${width}.png`) });
        await popup.evaluate((node) => {
          node.scrollTop = node.scrollHeight;
        });
        assert(await popup.isVisible(), 'inner scrolling keeps details open');
        await page.keyboard.press('Escape');
      }
      await button.click();
      await page.getByRole('textbox', { name: '分析需求' }).click();
      await popup.waitFor({ state: 'hidden' });
      await button.click();
      await page.setViewportSize({ width: 1024, height: 768 });
      await popup.waitFor({ state: 'hidden' });
      fixture.set(
        { tool: { name: 'ls', args: { path: '.' } }, usage: usage(10, 20, 30) },
        async () => {
          await stop.promise;
          return { text: 'cancelled', usage: usage(100, 100, 100) };
        },
      );
      await page.getByRole('textbox', { name: '分析需求' }).fill('Stop after known usage');
      await page.getByRole('button', { name: '发送分析需求', exact: true }).click();
      await until(() => fixture.requests.length === 4, 'second call waiting');
      await page.getByRole('button', { name: '停止', exact: true }).click();
      const stopped = await settled(page, id);
      assert.equal(stopped.turnUsage[1].totalTokens, 60);
      assert.equal(stopped.turnUsage[1].complete, false);
      assert.equal(stopped.turnUsage[1].status, 'cancelled');
      stop.release();
      assert.deepEqual(stopped.turnUsage[0], first.turnUsage[0]);
      const sessions = await rpc(page, { type: 'sessions.list' });
      const file = sessions.find((session) => session.id === id).sessionFile;
      const rows = readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert(rows.some((row) => row.message?.usage?.reasoning === 1000));
      assert.equal(rows.filter((row) => row.customType === 'data_agent.usage_boundary').length, 4);
      assert.deepEqual(app.errors, []);
      await app.stop();
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      page = app.page;
      await page.getByRole('button', { name: '查看本轮用量', exact: true }).first().waitFor();
      const restored = await rpc(page, { type: 'runtime.snapshot', sessionId: id });
      assert.deepEqual(restored.turnUsage, stopped.turnUsage);
      await page.getByRole('button', { name: '查看本轮用量', exact: true }).last().click();
      assert(
        (
          await page.getByRole('dialog', { name: '本轮用量详情', exact: true }).innerText()
        ).includes('统计可能不完整'),
      );
      assert.deepEqual(app.errors, []);
      return {
        totals: 13734,
        cacheHit: '87.9%',
        restart: true,
        cancelledPartial: true,
        nativeJsonl: true,
        keyboard: true,
        sizes: 3,
      };
    } finally {
      stop.release();
      await app.stop();
      await fixture.close();
    }
  },
  async 'P5-USAGE-QUEUES'({ dir }) {
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
