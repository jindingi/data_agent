import { openPreview } from '../../support/desktop.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { modelFixture } from '../../../scripts/test/model-fixture.mjs';
import { configure, rpc, settled } from '../../support/desktop.mjs';

const taskTool = (name, args) => ({ tool: { name, args } });

async function listing(page, sessionId) {
  return until(async () => {
    const v = await rpc(page, { type: 'artifacts.list', sessionId });
    return v.versions.length && v.versions.every((v) => v.state === 'published') ? v : null;
  }, 'all versions published');
}
export const cases = {
  async 'application.workflow'({ dir }) {
    const root = resolve(dir, 'p7-usability');
    mkdirSync(root, { recursive: true });
    const source = join(root, '拖拽 数据.csv');
    const bytes = Buffer.from([255, 0, 34, 10]);
    writeFileSync(source, bytes);
    const fixture = await modelFixture(),
      app = await startApp(join(root, 'app'), { testModelBaseUrl: fixture.baseUrl });
    let oldClipboard;
    try {
      const page = app.page;
      await configure(page);
      // A real disk-backed File enters the actual drop handler; no business IPC is called by the driver.
      await page.evaluate(() => {
        const input = document.createElement('input');
        input.type = 'file';
        input.id = 'cdp-disk-file';
        input.hidden = true;
        document.body.append(input);
      });
      const cdp = await app.browser.contexts()[0].newCDPSession(page);
      const document = await cdp.send('DOM.getDocument');
      const { nodeId } = await cdp.send('DOM.querySelector', {
        nodeId: document.root.nodeId,
        selector: '#cdp-disk-file',
      });
      await cdp.send('DOM.setFileInputFiles', { nodeId, files: [source] });
      await cdp.detach();
      await page.evaluate(() => {
        const file = document.querySelector('#cdp-disk-file').files[0],
          data = new DataTransfer();
        data.items.add(file);
        document
          .querySelector('.main-area')
          .dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: data }));
        document.querySelector('#cdp-disk-file').remove();
      });
      await page.getByRole('button', { name: '移除文件 拖拽 数据.csv', exact: true }).waitFor();
      assert.equal(await page.getByTestId('session-title').getAttribute('data-session-id'), null);
      const selected = await rpc(page, { type: 'files.inspect', paths: [source] });
      assert.equal(selected[0].path, source);
      assert.equal(selected[0].size, bytes.length);
      await page.getByLabel('输入区思考级别').selectOption('off');
      await until(
        async () => (await rpc(page, { type: 'models.settings' })).thinkingLevel === 'off',
        'composer thinking persisted',
      );
      const markdown = '# Copyable report\n\n中文 Markdown **原文**。\n';
      fixture.set(taskTool('write', { path: 'report.md', content: markdown }), {
        text: 'Report delivered.',
      });
      await page.getByRole('textbox', { name: '分析需求' }).fill('Generate report.md');
      await page.getByRole('button', { name: '发送分析需求', exact: true }).click();
      const id = await until(
        () => page.getByTestId('session-title').getAttribute('data-session-id'),
        'drop submission accepted',
      );
      await settled(page, id);
      await listing(page, id);
      await openPreview(page, '预览');
      await page.getByRole('heading', { name: 'Copyable report' }).waitFor();
      oldClipboard = execFileSync('/usr/bin/pbpaste');
      await page.getByRole('button', { name: '复制当前内容', exact: true }).click();
      await page.getByRole('status').filter({ hasText: '已复制当前内容' }).waitFor();
      assert.equal(execFileSync('/usr/bin/pbpaste', { encoding: 'utf8' }), markdown);
      await page.setViewportSize({ width: 940, height: 650 });
      const before = await page.locator('.main-area').boundingBox();
      await page.getByRole('button', { name: '展开结果面板', exact: true }).click();
      const report = await page.getByRole('complementary', { name: '结果面板' }).boundingBox(),
        after = await page.locator('.main-area').boundingBox();
      assert.equal(before.width, after.width);
      assert(report.width > 700);
      assert(report.x >= 0 && report.x + report.width <= 941);
      await page.screenshot({ path: join(root, 'expanded-report.png') });
      await page.getByRole('button', { name: '关闭结果面板', exact: true }).click();
      const send = await page
        .getByRole('button', { name: '发送分析需求', exact: true })
        .boundingBox();
      assert(send.x >= 0 && send.x + send.width <= 940);
      assert.deepEqual(readFileSync(source), bytes);
      assert.deepEqual(app.errors, []);
      return {
        diskFileDropThroughPreload: true,
        noCsvParsing: true,
        markdownClipboardExact: true,
        composerThinking: true,
        narrowReportOverlay: true,
      };
    } finally {
      if (oldClipboard !== undefined) execFileSync('/usr/bin/pbcopy', [], { input: oldClipboard });
      await app.stop();
      await fixture.close();
    }
  },
};
