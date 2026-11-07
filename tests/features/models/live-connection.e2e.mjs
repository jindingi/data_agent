import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { liveKey } from '../../../scripts/test/live-key.mjs';
import { configure, rpc } from '../../support/desktop.mjs';

/** One paid short probe through the actual Settings -> IPC -> utilityProcess path. */
async function probe({ dir }, provider, model, variable) {
  const key = liveKey(variable);
  let app;
  try {
    app = await startApp(join(dir, `live-connection-${provider}`));
    const { page } = app;
    await configure(page, key, provider, model);
    await page.getByRole('button', { name: '设置', exact: true }).click();
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
      provider,
      model,
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
}
export const cases = {
  'models.live-connection': (ctx) => probe(ctx, 'deepseek', 'deepseek-flash', 'DEEPSEEK_API_KEY'),
  'models.live-openrouter': (ctx) =>
    probe(ctx, 'openrouter', 'deepseek/deepseek-v4.1-flash', 'OPENROUTER_API_KEY'),
};
