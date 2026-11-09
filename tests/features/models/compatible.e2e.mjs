import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { modelFixture } from '../../../scripts/test/model-fixture.mjs';
import { configureCompatible } from '../../support/compatible-models.mjs';
import { rpc, submit, settled } from '../../support/desktop.mjs';

export const cases = {
  async 'models.compatible-ui'({ dir }) {
    const fixture = await modelFixture();
    let app;
    const root = join(dir, 'compatible-ui');
    try {
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      const { page } = app;
      fixture.setListingStatus(404);
      for (const provider of ['openai-chat-compatible', 'openai-responses-compatible']) {
        const settings = await configureCompatible(page, {
          provider,
          baseUrl: fixture.baseUrl,
          key: `fixture-${provider}`,
          model: 'private-alias',
        });
        assert.equal(settings.selected.provider, provider);
        assert.equal(settings.compatibleModels[provider][0].contextWindow, 131072);
        await page.getByRole('button', { name: '设置', exact: true }).click();
        assert.equal(await page.getByLabel('已保存 API key').inputValue(), '********');
        assert(
          (await page.getByTestId('compatible-endpoint').innerText()).endsWith(
            provider === 'openai-chat-compatible' ? '/chat/completions' : '/responses',
          ),
        );
        fixture.set({ text: 'OK' });
        await page.getByRole('button', { name: '测试模型连接', exact: true }).click();
        await page.getByRole('status').filter({ hasText: '连接测试通过' }).waitFor();
        await page.getByRole('button', { name: '关闭对话框' }).click();
        fixture.set(
          { tool: { name: 'ls', args: { path: '.' } } },
          { text: `Finished ${provider}` },
        );
        const sessionId = await submit(page, 'List the workspace once, then finish.');
        const state = await settled(page, sessionId);
        assert.equal(state.state, 'completed', state.error);
        assert(state.tools.some((t) => t.name === 'ls' && t.status === 'completed'));
        assert(state.turnUsage.some((u) => u.calls === 2));
        fixture.set({ delay: 1500, text: 'This request should be cancelled.' });
        const cancelId = await submit(page, 'Wait for a response.');
        await page.getByRole('button', { name: '停止', exact: true }).click();
        const cancelled = await settled(page, cancelId);
        assert.equal(cancelled.state, 'cancelled');
      }
      await page.getByRole('button', { name: '设置', exact: true }).click();
      for (const theme of ['light', 'dark']) {
        await page.evaluate((theme) => {
          document.documentElement.dataset.theme = theme;
        }, theme);
        for (const [width, height] of [
          [900, 700],
          [1280, 800],
          [1600, 1000],
        ]) {
          await page.setViewportSize({ width, height });
          await page.getByLabel('兼容模型 ID').scrollIntoViewIfNeeded();
          const dialog = page.getByRole('dialog', { name: '设置', exact: true });
          const bounds = await dialog.boundingBox();
          assert(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width + 1);
          assert(await page.getByLabel('兼容模型 ID').isVisible());
          await page.screenshot({ path: join(dir, `compatible-${theme}-${width}.png`) });
          await page.getByRole('checkbox', { name: '支持图片输入' }).scrollIntoViewIfNeeded();
          await page.screenshot({ path: join(dir, `compatible-${theme}-${width}-bottom.png`) });
        }
      }
      await page.getByRole('button', { name: '关闭对话框' }).click();
      await app.stop();
      app = undefined;
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      const restored = await rpc(app.page, { type: 'models.settings' });
      assert.equal(restored.compatibleModels['openai-chat-compatible'][0].model, 'private-alias');
      assert.equal(
        restored.compatibleModels['openai-responses-compatible'][0].model,
        'private-alias',
      );
      assert.equal(restored.models.filter((m) => m.model === 'private-alias').length, 2);
      await until(
        async () =>
          (await rpc(app.page, { type: 'models.settings' })).configuredProviders.length === 2,
        'both connections restored',
      );
      return { protocols: 2, sizes: 3, themes: 2, restart: true, directoryOptional: true };
    } finally {
      await app?.stop();
      await fixture.close();
    }
  },
};
