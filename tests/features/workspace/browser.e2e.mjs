import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { createStoredSession, openPreview } from '../../support/desktop.mjs';
export const cases = {
  async 'workspace.browser'({ dir }) {
    const target = join(dir, 'saved.py');
    const app = await startApp(join(dir, 'app'), { saveFile: target });
    try {
      const session = await createStoredSession(app.page);
      mkdirSync(join(session.workspace, 'nested'));
      writeFileSync(join(session.workspace, 'nested/code.py'), 'print("你好")');
      writeFileSync(
        join(session.workspace, 'report.md'),
        '# 工作区报告\n\n[代码](nested/code.py)\n\n' + '阅读内容\n\n'.repeat(150) + '报告尾部',
      );
      writeFileSync(join(session.workspace, 'data.csv'), '地区,金额\n上海,100');
      await openPreview(app.page, '文件');
      await app.page.getByRole('button', { name: '刷新工作区', exact: true }).click();
      await app.page.getByRole('button', { name: 'nested', exact: true }).click();
      await app.page.getByRole('button', { name: 'code.py', exact: true }).click();
      await until(
        () =>
          app.page
            .locator('.source-code')
            .textContent()
            .then((t) => t === 'print("你好")'),
        'source preview',
      );
      await app.page.getByRole('button', { name: '另存文件', exact: true }).click();
      await app.page.getByRole('status').filter({ hasText: '文件已另存' }).waitFor();
      assert.equal(readFileSync(target, 'utf8'), 'print("你好")');
      await app.page.getByRole('tab', { name: '文件', exact: true }).click();
      await app.page.getByRole('button', { name: 'report.md', exact: true }).click();
      await app.page.getByRole('heading', { name: '工作区报告' }).waitFor();
      const scroll = app.page.locator('[data-state="active"].artifact-scroll');
      await scroll.hover();
      await app.page.mouse.wheel(0, 20000);
      await until(
        () =>
          scroll.evaluate(
            (e) => e.scrollTop > 0 && e.scrollTop + e.clientHeight >= e.scrollHeight - 5,
          ),
        'preview scroll tail',
      );
      assert.equal(await app.page.getByRole('button', { name: '解除关联' }).count(), 0);
      for (const [width, height] of [
        [1440, 900],
        [1100, 720],
        [800, 600],
      ]) {
        await app.page.setViewportSize({ width, height });
        for (const theme of ['light', 'dark']) {
          await app.page.evaluate(
            (theme) => (document.documentElement.dataset.theme = theme),
            theme,
          );
          await app.page.screenshot({ path: join(dir, `workspace-${width}-${theme}.png`) });
        }
      }
      assert.deepEqual(app.errors, []);
      return { directoryPreviewSaveAndScroll: true };
    } finally {
      await app.stop();
    }
  },
};
