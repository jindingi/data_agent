import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { liveKey } from '../../../scripts/test/live-key.mjs';
import { configure, rpc } from '../../support/desktop.mjs';

/** One paid short probe through the actual Settings -> IPC -> utilityProcess path. */
export const cases = {
  async 'models.live-connection'({ dir }) {
    const key = liveKey();
    let app;
    try {
      app = await startApp(join(dir, 'live-connection'));
      const { page } = app;
      await configure(page, key);
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByLabel('测试模型', { exact: true }).selectOption('deepseek-flash');
      const started = Date.now();
      await page.getByRole('button', { name: '测试模型连接', exact: true }).click();
      const outcome = await until(
        async () => {
          const text = await page.locator('.settings-body').innerText();
          if (text.includes('连接测试通过')) return 'passed';
          const errors = await page.getByRole('alert').allTextContents();
          return errors.filter(Boolean).join(' / ') || null;
        },
        'live connection probe settles',
        35_000,
      );
      assert.equal(outcome, 'passed');
      assert.equal((await rpc(page, { type: 'sessions.list' })).length, 0);
      return {
        provider: 'deepseek',
        model: 'deepseek-flash',
        elapsedMs: Date.now() - started,
        liveRequests: 1,
      };
    } catch (error) {
      // eslint-disable-next-line preserve-caught-error -- Playwright failures may echo the key entered into the form.
      throw new Error(
        String(error instanceof Error ? error.stack : error).replaceAll(key, '<REDACTED>'),
      );
    } finally {
      await app?.stop();
    }
  },
};
