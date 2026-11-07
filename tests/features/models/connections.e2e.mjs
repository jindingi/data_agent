import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { modelFixture } from '../../../scripts/test/model-fixture.mjs';
import { configure, rpc, selectModel } from '../../support/desktop.mjs';

async function assertKeyAlignment(page) {
  const alignment = await page.locator('.saved-credential').evaluate((row) => {
    const input = row.querySelector('input').getBoundingClientRect();
    const button = row.querySelector('button').getBoundingClientRect();
    return Math.abs((input.top + input.bottom) / 2 - (button.top + button.bottom) / 2);
  });
  assert(alignment <= 1, `Key button center differs by ${alignment}px`);
}

async function assertThinkingAlignment(page) {
  const alignment = await page.locator('.thinking-setting').evaluate((row) => {
    const select = row.querySelector('select').getBoundingClientRect();
    const button = row.querySelector('button').getBoundingClientRect();
    return Math.abs((select.top + select.bottom) / 2 - (button.top + button.bottom) / 2);
  });
  assert(alignment <= 1, `Thinking reset button center differs by ${alignment}px`);
}

export const cases = {
  async 'models.connections-ui'({ dir }) {
    const fixture = await modelFixture();
    const root = join(dir, 'connections');
    let app;
    try {
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      const { page } = app;
      await configure(page, 'synthetic-original');
      await page.getByRole('button', { name: '设置', exact: true }).click();
      assert.equal(
        await page.getByLabel('已保存 API key', { exact: true }).inputValue(),
        '********',
      );
      assert.equal(
        await page.getByLabel('已保存 API key', { exact: true }).getAttribute('type'),
        'password',
      );
      await assertKeyAlignment(page);
      await assertThinkingAlignment(page);
      const initial = await rpc(page, { type: 'models.settings' });
      assert.deepEqual(
        await page
          .getByLabel('连接提供方', { exact: true })
          .locator('option')
          .evaluateAll((nodes) => nodes.map((n) => n.value)),
        ['deepseek', 'openrouter'],
      );
      assert(!initial.models.some((m) => m.model === 'unknown-new-model'));
      fixture.setListingStatus(401);
      await page.getByRole('button', { name: '获取模型列表', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: '模型列表鉴权失败' }).waitFor();
      assert(
        !(await page.locator('.settings-dialog').innerText()).includes('synthetic-private-error'),
      );
      assert.deepEqual((await rpc(page, { type: 'models.settings' })).models, initial.models);
      fixture.setListingStatus(200);
      await page.getByRole('button', { name: '获取模型列表', exact: true }).click();
      await page.getByRole('status').filter({ hasText: '已获取' }).waitFor();
      assert.equal(await page.getByLabel('搜索模型', { exact: true }).count(), 0);
      await page.getByRole('button', { name: '选择模型', exact: true }).click();
      await page.getByLabel('搜索模型', { exact: true }).fill('no-such-model-xyz');
      await page.getByRole('status').filter({ hasText: '没有匹配的模型' }).waitFor();
      assert.equal(await page.locator('.model-picker-popover').getByRole('option').count(), 0);
      await page.getByLabel('搜索模型', { exact: true }).press('Escape');
      assert(await page.getByRole('dialog', { name: '设置', exact: true }).isVisible());
      await until(
        () =>
          page
            .getByRole('button', { name: '选择模型', exact: true })
            .evaluate((el) => el === document.activeElement),
        'picker focus restored',
      );
      await page.getByRole('button', { name: '选择模型', exact: true }).press('Enter');
      const search = page.getByRole('combobox', { name: '搜索模型', exact: true });
      await until(
        () => search.evaluate((el) => el === document.activeElement),
        'search auto focused',
      );
      await search.press('Home');
      const firstOption = await search.getAttribute('aria-activedescendant');
      await search.press('ArrowDown');
      assert.notEqual(await search.getAttribute('aria-activedescendant'), firstOption);
      await search.press('ArrowUp');
      assert.equal(await search.getAttribute('aria-activedescendant'), firstOption);
      await search.fill('DeepSeek-V41-Flash');
      await search.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
      assert(await page.locator('.model-picker-popover').isVisible());
      await search.press('Enter');
      await page.locator('.model-picker-popover').waitFor({ state: 'hidden' });
      assert.deepEqual((await rpc(page, { type: 'models.settings' })).selected, initial.selected);
      await until(
        () =>
          page
            .getByRole('button', { name: '选择模型', exact: true })
            .evaluate((el) => el === document.activeElement),
        'selection restores focus',
      );
      await page.getByRole('button', { name: '更换 Key', exact: true }).click();
      await page.getByLabel('API key', { exact: true }).fill('synthetic-unsaved');
      await page.getByLabel('连接提供方', { exact: true }).selectOption('openrouter');
      assert.deepEqual((await rpc(page, { type: 'models.settings' })).selected, initial.selected);
      await page.getByLabel('API key', { exact: true }).fill('synthetic-other-provider');
      await page.getByLabel('连接提供方', { exact: true }).selectOption('deepseek');
      assert.equal(
        await page.getByLabel('API key', { exact: true }).inputValue(),
        'synthetic-unsaved',
      );
      assert(await page.getByLabel('选择模型', { exact: true }).isDisabled());
      await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
      await page.getByRole('button', { name: '设置', exact: true }).click();
      assert.equal(
        await page.getByLabel('API key', { exact: true }).inputValue(),
        'synthetic-unsaved',
      );
      await page.getByLabel('API Base URL', { exact: true }).fill('http://unsafe.example');
      await page.getByRole('button', { name: '保存凭证', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'HTTPS' }).waitFor();
      assert.equal(
        await page.getByLabel('API key', { exact: true }).inputValue(),
        'synthetic-unsaved',
      );
      assert.equal((await rpc(page, { type: 'models.settings' })).endpoints.deepseek, '');
      await page.getByLabel('API Base URL', { exact: true }).fill(fixture.baseUrl);
      await page.getByRole('button', { name: '保存凭证', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'API key 已保存' }).waitFor();
      assert.equal(
        (await rpc(page, { type: 'models.settings' })).endpoints.deepseek,
        fixture.baseUrl,
      );
      await selectModel(page, 'deepseek-flash');
      fixture.set({ status: 401, error: 'synthetic-unsaved' });
      await page.getByRole('button', { name: '测试模型连接', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: '鉴权失败' }).waitFor();
      assert(!(await page.locator('.settings-body').innerText()).includes('synthetic-unsaved'));
      fixture.set({ text: 'OK', delay: 250 });
      await page.getByRole('button', { name: '测试模型连接', exact: true }).click();
      await page.getByRole('button', { name: '正在测试模型…', exact: true }).waitFor();
      await page.getByRole('status').filter({ hasText: '连接测试通过' }).waitFor();
      assert.equal(fixture.requests.length, 2);
      assert.equal(fixture.authorizations.at(-1), 'Bearer synthetic-unsaved');
      assert.equal((await rpc(page, { type: 'sessions.list' })).length, 0);
      await page.getByRole('button', { name: '移除凭证', exact: true }).click();
      assert(
        (await rpc(page, { type: 'models.settings' })).configuredProviders.includes('deepseek'),
      );
      await page.getByRole('button', { name: '取消移除', exact: true }).click();
      // Header/close stay visible while every section can be reached at each supported size/theme.
      for (const [width, height] of [
        [1440, 900],
        [1180, 760],
        [900, 650],
      ]) {
        await page.setViewportSize({ width, height });
        const body = page.locator('.settings-body');
        for (const theme of ['light', 'dark']) {
          await page.getByRole('tab', { name: '模型与连接', exact: true }).click();
          await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
          await body.evaluate((el) => {
            el.scrollTop = 0;
          });
          await page.screenshot({ path: join(root, `settings-${width}-${theme}-top.png`) });
          await page.getByLabel('已保存 API key', { exact: true }).scrollIntoViewIfNeeded();
          await assertKeyAlignment(page);
          await page.screenshot({ path: join(root, `settings-${width}-${theme}-credential.png`) });
          await page.getByRole('button', { name: '选择模型', exact: true }).click();
          const popup = page.locator('.model-picker-popover');
          const box = await popup.boundingBox();
          assert(
            box &&
              box.x >= 0 &&
              box.y >= 0 &&
              box.x + box.width <= width &&
              box.y + box.height <= height,
          );
          assert.equal(await popup.evaluate((el) => el.scrollWidth > el.clientWidth), false);
          await page.screenshot({
            path: join(root, `settings-${width}-${theme}-picker.png`),
            animations: 'disabled',
          });
          await page.getByRole('combobox', { name: '搜索模型', exact: true }).press('Escape');
          await page.getByLabel('思考级别', { exact: true }).scrollIntoViewIfNeeded();
          await assertThinkingAlignment(page);
          const reset = page.getByRole('button', { name: '恢复推荐级别', exact: true });
          assert(await reset.isDisabled());
          await page.getByLabel('思考级别', { exact: true }).selectOption('off');
          await until(() => reset.isEnabled(), 'reset enabled');
          await assertThinkingAlignment(page);
          await reset.click();
          await until(
            async () => (await rpc(page, { type: 'models.settings' })).thinkingLevel === 'high',
            'recommended thinking restored',
          );
          await page.screenshot({
            path: join(root, `settings-${width}-${theme}-thinking.png`),
            animations: 'disabled',
          });
          const geometry = await page.locator('.settings-dialog').evaluate((dialog) => {
            const body = dialog.querySelector('.settings-body'),
              header = dialog.querySelector('.settings-header');
            return {
              overflow: dialog.scrollWidth > dialog.clientWidth,
              scrolled: body.scrollTop > 0,
              headerTop: header.getBoundingClientRect().top,
              dialogTop: dialog.getBoundingClientRect().top,
            };
          });
          assert.equal(geometry.overflow, false);
          assert.equal(geometry.scrolled, true);
          assert(Math.abs(geometry.headerTop - geometry.dialogTop) < 2);
          await page.screenshot({ path: join(root, `settings-${width}-${theme}-bottom.png`) });
          await page.getByRole('tab', { name: '本地与诊断', exact: true }).click();
          await page.getByText('应用诊断', { exact: true }).click();
          await page.getByRole('button', { name: '检查本地引擎', exact: true }).click();
          await page.getByRole('status').filter({ hasText: '本地引擎正常' }).waitFor();
        }
      }
      assert.equal(fixture.requests.length, 2, 'Local health check must not call the model');
      await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
      await until(
        () =>
          page
            .getByRole('button', { name: '设置', exact: true })
            .evaluate((el) => el === document.activeElement),
        'settings focus restored',
      );
      await app.stop();
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      const restored = await rpc(app.page, { type: 'models.settings' });
      assert.equal(restored.endpoints.deepseek, fixture.baseUrl);
      assert(!JSON.stringify(restored).includes('synthetic-unsaved'));
      assert(!restored.configuredProviders.includes('openrouter'));
      assert.deepEqual(app.errors, []);
      return {
        maskedKey: true,
        providerDrafts: true,
        independentModelChoice: true,
        endpointPersisted: true,
        realSdkProbe: true,
        authFailure: true,
        localDiagnosticSeparate: true,
        layouts: 6,
      };
    } finally {
      await app?.stop();
      await fixture.close();
    }
  },
};
