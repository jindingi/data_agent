import { openPreview } from '../../support/desktop.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startApp } from '../../../scripts/test/harness.mjs';

async function info(page) {
  const result = await page.evaluate(() => window.dataAgent.request({ type: 'system.info' }));
  assert.equal(result.ok, true);
  return result.value;
}
export const cases = {
  async 'application.cdp'({ dir }) {
    const app = await startApp(join(dir, 'desktop'));
    try {
      const { page } = app;
      const startup = JSON.parse(readFileSync(join(app.root, 'data/automation.json'), 'utf8'));
      assert.equal(startup.background, true);
      assert.equal(startup.windowVisible, false);
      assert.equal(startup.windowFocused, false);
      await page.getByRole('textbox', { name: '分析需求' }).fill('分析地区销售变化');
      assert.equal(
        await page.getByRole('textbox', { name: '分析需求' }).inputValue(),
        '分析地区销售变化',
      );
      await page.getByRole('button', { name: '切换结果面板' }).click();
      await openPreview(page, '预览');
      await page.getByText('从文件列表选择文件进行预览', { exact: true }).waitFor();
      await page.getByRole('button', { name: '关闭结果面板' }).click();
      await page.getByRole('button', { name: '收起侧栏' }).click();
      assert.equal(await page.getByLabel('会话侧栏').count(), 0);
      await page.getByRole('button', { name: '展开侧栏' }).click();
      await page.getByRole('button', { name: '看清变化', exact: false }).click();
      assert.match(
        await page.getByRole('textbox', { name: '分析需求' }).inputValue(),
        /最近 3 个月/,
      );
      await page.screenshot({ path: join(dir, 'desktop.png') });
      assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
      assert.deepEqual(app.errors, []);
      return { screenshot: 'desktop.png', info: await info(page) };
    } finally {
      await app.stop();
    }
  },
};
