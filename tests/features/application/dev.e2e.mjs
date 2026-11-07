import { createStoredSession } from '../../support/desktop.mjs';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { until } from '../../../scripts/test/harness.mjs';
import { startDevApp } from '../../../scripts/test/dev-harness.mjs';

export const cases = {
  async 'application.dev'({ dir }) {
    const app = await startDevApp(join(dir, 'vite-dev'));
    try {
      const page = app.page;
      const result = await page.evaluate(() => window.dataAgent.request({ type: 'system.info' }));
      assert.equal(result.ok, true, JSON.stringify({ url: page.url(), result }));
      assert.match(page.url(), /^http:\/\/localhost:\d+\/$/);
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByText('应用诊断', { exact: true }).click();
      await page.getByRole('button', { name: '检查连接' }).click();
      await page.getByRole('status').filter({ hasText: '连接正常' }).waitFor();
      await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
      await page.getByRole('button', { name: '新会话', exact: true }).click();
      assert.equal(await page.getByTestId('session-title').getAttribute('data-session-id'), null);
      const { id } = await createStoredSession(page);
      await page.reload();
      await until(
        async () =>
          (await page.getByTestId('session-title').getAttribute('data-session-id')) === id,
        'dev session restored',
      );
      assert.equal(
        (
          await page.evaluate(() =>
            window.dataAgent.request({ type: 'system.ping', text: 'after-reload' }),
          )
        ).ok,
        true,
      );
      assert.equal(await page.getByText('请求来源不受信任', { exact: true }).count(), 0);
      const trustedURL = page.url();
      // CDP navigation bypasses the product's link handler: Main must still reject
      // a different document, even when served by the same development origin.
      await page.goto(`${trustedURL}?untrusted=1`);
      await page.getByRole('textbox', { name: '分析需求' }).waitFor();
      const rejected = await page.evaluate(() => window.dataAgent.request({ type: 'system.info' }));
      assert.equal(rejected.ok, false);
      assert.equal(rejected.error.code, 'UNTRUSTED_SENDER');
      await page.goto(trustedURL);
      await page.getByRole('textbox', { name: '分析需求' }).waitFor();
      assert.equal(
        (await page.evaluate(() => window.dataAgent.request({ type: 'system.info' }))).ok,
        true,
      );
      assert.deepEqual(app.errors, []);
      return {
        realPnpmDev: true,
        url: page.url(),
        nativeIPC: true,
        sessionCreateAndReload: true,
        sameOriginOtherDocumentRejected: true,
      };
    } finally {
      await app.stop();
    }
  },
};
