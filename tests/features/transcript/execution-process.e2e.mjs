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
export const cases = {
  async 'transcript.execution-process'({ dir }) {
    const fixture = await modelFixture();
    const next = gate(),
      finish = gate(),
      stop = gate();
    const root = join(dir, 'execution-process');
    let app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
    try {
      let page = app.page;
      await configure(page);
      fixture.set(
        { tool: { name: 'read', args: { path: 'missing.csv' } } },
        async () => {
          await next.promise;
          return { tool: { name: 'ls', args: { path: '.' } } };
        },
        async () => {
          await finish.promise;
          return { text: 'FINAL_ANSWER_OUTSIDE_PROCESS' };
        },
      );
      const id = await submit(page, 'Group thinking and tools for this question.');
      const process = page.locator('.execution-process').first();
      const toggle = process.locator('.process-toggle');
      await until(() => fixture.requests.length >= 2, 'first tool finished');
      await until(
        () => toggle.getAttribute('aria-expanded').then((v) => v === 'true'),
        'active process opens',
      );
      assert.equal(await page.locator('.execution-process').count(), 1);
      await toggle.click();
      next.release();
      await until(() => fixture.requests.length >= 3, 'second tool finished');
      assert.equal(
        await toggle.getAttribute('aria-expanded'),
        'false',
        'new events preserve manual collapse',
      );
      await toggle.click();
      await page.screenshot({ path: join(dir, 'process-running.png') });
      await process.locator('.tool-card summary').first().focus();
      finish.release();
      const first = await settled(page, id);
      assert.equal(first.state, 'completed');
      await until(
        () => toggle.getAttribute('aria-expanded').then((v) => v === 'false'),
        'completion auto collapses',
      );
      assert.equal(await process.locator('.tool-card').count(), 2);
      assert.equal(await process.locator('.thinking-card').count(), 3);
      assert(
        await toggle.evaluate((node) => node === document.activeElement),
        'collapse returns hidden focus to the process toggle',
      );
      assert((await toggle.innerText()).includes('2 次工具调用'));
      assert((await toggle.innerText()).includes('1 次工具失败'));
      await page.getByText('FINAL_ANSWER_OUTSIDE_PROCESS', { exact: true }).waitFor();
      assert.equal(await process.getByText('FINAL_ANSWER_OUTSIDE_PROCESS').count(), 0);
      await page.screenshot({ path: join(dir, 'process-collapsed-dark.png') });
      await toggle.focus();
      const scrollBefore = await page.locator('.history-list').evaluate((node) => node.scrollTop);
      await page.keyboard.press('Enter');
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      );
      assert.equal(
        await page.locator('.history-list').evaluate((node) => node.scrollTop),
        scrollBefore,
        'manual inspection does not jump to latest',
      );
      assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
      await process.locator('.thinking-card summary').first().click();
      await process.locator('.tool-card summary').first().click();
      await process.getByRole('heading', { name: '参数', exact: true }).first().waitFor();
      assert((await process.innerText()).includes('missing.csv'));
      await page.getByRole('button', { name: '切换到浅色模式', exact: true }).click();
      await page.screenshot({ path: join(dir, 'process-expanded-light.png') });
      const preservedProcess = await process.elementHandle();
      fixture.set({ tool: { name: 'ls', args: { path: '.' } } }, { text: 'SECOND_TURN_ANSWER' });
      await page.getByRole('textbox', { name: '分析需求' }).fill('Next question.');
      await page.getByRole('button', { name: '发送分析需求', exact: true }).click();
      await until(async () => {
        const value = await rpc(page, { type: 'runtime.snapshot', sessionId: id });
        return value.runId !== first.runId && value.state === 'completed';
      }, 'second turn completed');
      assert(
        await preservedProcess.evaluate((node) => node.isConnected),
        'same-session submit must preserve the existing process DOM and focus state',
      );
      assert.equal(await page.locator('.execution-process').count(), 2);
      assert.equal(
        await toggle.getAttribute('aria-expanded'),
        'true',
        'finished manual expansion stays open',
      );
      assert.equal(
        await page.locator('.process-toggle').last().getAttribute('aria-expanded'),
        'false',
      );
      fixture.set({ tool: { name: 'ls', args: { path: '.' } } }, async () => {
        await stop.promise;
        return { text: 'CANCELLED_REPLY' };
      });
      const before = fixture.requests.length;
      await page.getByRole('textbox', { name: '分析需求' }).fill('A turn that I will stop.');
      await page.getByRole('button', { name: '发送分析需求', exact: true }).click();
      await until(() => fixture.requests.length >= before + 2, 'stoppable turn has process');
      await page.getByRole('button', { name: '停止', exact: true }).click();
      assert.equal((await settled(page, id)).state, 'cancelled');
      await until(
        () =>
          page
            .locator('.process-toggle')
            .last()
            .getAttribute('aria-expanded')
            .then((v) => v === 'false'),
        'stop collapses process',
      );
      stop.release();
      for (let index = 0; index < 10; index++) {
        fixture.set({ text: `PAGING_ANSWER_${index}` });
        await page.getByRole('textbox', { name: '分析需求' }).fill(`Pagination question ${index}`);
        await page.getByRole('button', { name: '发送分析需求', exact: true }).click();
        await page.getByText(`PAGING_ANSWER_${index}`, { exact: true }).waitFor();
        assert.equal((await settled(page, id)).state, 'completed');
      }
      assert.deepEqual(app.errors, []);
      await app.stop();
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      page = app.page;
      await page.getByText('PAGING_ANSWER_9', { exact: true }).waitFor();
      assert.equal(
        await page.locator('.process-toggle[aria-expanded="true"]').count(),
        0,
        'restored history starts collapsed',
      );
      assert.equal(await page.locator('.transcript-turn').count(), 10);
      await page.getByRole('button', { name: '加载更早消息', exact: true }).click();
      assert.equal(await page.locator('.transcript-turn').count(), 13);
      assert.equal(
        await page.locator('.execution-process').first().locator('.tool-card').count(),
        2,
        'older turn is restored as a whole',
      );
      assert.deepEqual(app.errors, []);
      return {
        automaticCollapse: true,
        manualOverride: true,
        allStepsGrouped: true,
        answersOutside: true,
        failureSummary: true,
        stoppedAndRestoredCollapsed: true,
      };
    } finally {
      next.release();
      finish.release();
      stop.release();
      await app.stop();
      await fixture.close();
    }
  },
};
