import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { modelFixture } from '../../../scripts/test/model-fixture.mjs';
import { configure, submit, settled, rpc } from '../../support/desktop.mjs';

export const cases = {
  async 'transcript.reading'({ dir }) {
    const fixture = await modelFixture();
    const app = await startApp(join(dir, 'ux-reading'), { testModelBaseUrl: fixture.baseUrl });
    try {
      const page = app.page;
      await configure(page);
      const report =
        '# 阅读验证\n\n' +
        Array.from(
          { length: 60 },
          (_, i) =>
            `## 第 ${i + 1} 节\n\n正文用于验证可达性和滚动稳定性。\n\n| 列 A | 列 B |\n| --- | --- |\n| 中文 | ${'long-value-'.repeat(30)} |\n\n`,
        ).join('') +
        '\nREPORT-END-MARKER\n';
      fixture.set(
        { tool: { name: 'write', args: { path: 'report.md', content: report } } },
        { text: report },
      );
      const id = await submit(page, '生成 report.md');
      assert.equal((await settled(page, id)).state, 'completed');
      await until(
        async () => (await rpc(page, { type: 'artifacts.list', sessionId: id })).files.length > 0,
        'artifact ready',
      );
      await page.getByRole('button', { name: '切换结果面板' }).click();
      await page.getByRole('tab', { name: '预览', exact: true }).click();
      await page.locator('.artifact-markdown').waitFor();
      for (const [width, height] of [
        [1440, 900],
        [1280, 800],
        [940, 650],
      ]) {
        await page.setViewportSize({ width, height });
        for (const theme of ['light', 'dark']) {
          const toggle = page.getByRole('button', {
            name: theme === 'light' ? '切换到浅色模式' : '切换到深色模式',
          });
          if (await toggle.count()) {
            await page.getByRole('button', { name: '关闭结果面板' }).click();
            await toggle.click();
            await page.getByRole('button', { name: '切换结果面板' }).click();
          }
          const pane = page.locator('.artifact-scroll');
          await pane.focus();
          await page.keyboard.press('Control+End');
          // Native wheel scrolling must move the actual preview, independently of chat.
          const before = await page.locator('.history-list').evaluate((n) => n.scrollTop);
          await pane.hover();
          for (let n = 0; n < 8; n++) await page.mouse.wheel(0, 8000);
          await until(
            () => pane.evaluate((n) => n.scrollHeight - n.scrollTop - n.clientHeight < 4),
            'preview end reached',
          );
          const marker = pane.getByText('REPORT-END-MARKER', { exact: true });
          const box = await marker.boundingBox();
          assert(box && box.y >= 0 && box.y + box.height <= height, 'report tail in viewport');
          assert.equal(await page.locator('.history-list').evaluate((n) => n.scrollTop), before);
          assert(
            await page
              .locator('.artifact-toolbar')
              .evaluate((n) => n.getBoundingClientRect().height + 52 <= 120),
          );
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          await page.screenshot({ path: join(dir, `ux-${width}-${theme}.png`) });
        }
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      const splitter = page.getByRole('separator', { name: '调整预览宽度' });
      await splitter.focus();
      const initial = await page.locator('.result-panel').evaluate((n) => n.clientWidth);
      await page.keyboard.press('ArrowLeft');
      assert((await page.locator('.result-panel').evaluate((n) => n.clientWidth)) > initial);
      const b = await splitter.boundingBox();
      await page.mouse.move(b.x + 4, b.y + 150);
      await page.mouse.down();
      await page.mouse.move(b.x - 70, b.y + 150);
      await page.mouse.up();
      assert((await page.locator('.result-panel').evaluate((n) => n.clientWidth)) > initial + 32);
      const version = await page.getByLabel('选择预览文件').inputValue();
      await page.getByRole('button', { name: '展开结果面板' }).click();
      await page.getByRole('button', { name: '缩小结果面板' }).click();
      assert.equal(await page.getByLabel('选择预览文件').inputValue(), version);
      await page.getByRole('button', { name: '关闭结果面板' }).hover();
      await page.getByRole('tooltip', { name: '关闭结果面板' }).waitFor();
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '关闭结果面板' }).click();
      const chat = page.locator('.history-list');
      await chat.hover();
      await page.mouse.wheel(0, -1500);
      await page.getByRole('button', { name: '回到最新消息' }).waitFor();
      assert.equal(await page.locator('.history-pagination').count(), 0);
      assert.equal(
        await page.locator('.history-message.assistant > .markdown-body .paged-text').count(),
        0,
      );
      await page.getByRole('button', { name: '回到最新消息' }).click();
      assert.deepEqual(app.errors, []);
      return {
        reportWheelEnd: true,
        independentScroll: true,
        resizePointerAndKeyboard: true,
        themesAndViewports: 6,
        continuousMarkdown: true,
        tooltip: true,
      };
    } finally {
      await app.stop();
      await fixture.close();
    }
  },
};
