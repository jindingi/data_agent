import { openPreview, openWorkspaceFile } from '../../support/desktop.mjs';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startApp } from '../../../scripts/test/harness.mjs';
import { modelFixture } from '../../../scripts/test/model-fixture.mjs';
import { configure, settled, submit } from '../../support/desktop.mjs';

export const cases = {
  async 'artifacts.result-state'({ dir }) {
    const fixture = await modelFixture(),
      app = await startApp(join(dir, 'p4-result-state'), { testModelBaseUrl: fixture.baseUrl });
    try {
      const page = app.page;
      await configure(page);
      fixture.set({ text: 'I claim the report is correct, but no files were created.' });
      let id = await submit(page);
      assert.equal((await settled(page, id)).state, 'completed');
      await openPreview(page, '预览');
      await page.getByText('从文件列表选择文件进行预览').waitFor();
      fixture.set(
        { tool: { name: 'write', args: { path: 'report.md', content: '' } } },
        { tool: { name: 'write', args: { path: 'chart.png', content: 'broken png' } } },
        { text: 'Finished.' },
      );
      id = await submit(page);
      await settled(page, id);
      await openWorkspaceFile(page, 'report.md');
      await page.getByText('文件为空', { exact: true }).waitFor();
      await openWorkspaceFile(page, 'chart.png');
      await page.getByText('图片无效或超过 4,000 万像素，无法预览', { exact: true }).waitFor();
      fixture.set(
        {
          tool: {
            name: 'write',
            args: { path: 'report.md', content: '# Intentionally wrong answer\n\n1 + 1 = 9' },
          },
        },
        { text: 'Finished.' },
      );
      id = await submit(page);
      await settled(page, id);
      await openPreview(page, '预览');
      await page.getByRole('heading', { name: 'Intentionally wrong answer' }).waitFor();
      assert((await page.locator('.artifact-markdown').innerText()).includes('1 + 1 = 9'));
      assert.deepEqual(app.errors, []);
      return {
        executionSeparateFromFiles: true,
        missing: true,
        empty: true,
        damagedPng: true,
        semanticallyWrongReportStillDisplays: true,
      };
    } finally {
      await app.stop();
      await fixture.close();
    }
  },
};
