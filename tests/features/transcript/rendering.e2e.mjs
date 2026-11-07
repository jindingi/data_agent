import { openPreview } from '../../support/desktop.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { modelFixture } from '../../../scripts/test/model-fixture.mjs';
import { rpc, configure, submit, settled } from '../../support/desktop.mjs';

async function published(page, sessionId) {
  return until(async () => {
    const value = await rpc(page, { type: 'artifacts.list', sessionId });
    return value.versions.length && value.versions.every((v) => v.state === 'published')
      ? value
      : null;
  }, 'outputs published');
}
export const cases = {
  async 'transcript.rendering'({ dir }) {
    const root = resolve(dir, 'p6-render'),
      fixture = await modelFixture();
    let app;
    mkdirSync(root, { recursive: true });
    const secret = join(root, 'private-text.txt');
    writeFileSync(secret, 'PRIVATE_FILE_MUST_NOT_RENDER');
    const hostile = `# Safe report heading\n\n<script>window.__p6Executed=true</script>\n\n<img src="x" onerror="window.__p6Executed=true">\n\n![remote](https://p6-untrusted.invalid/remote.png)\n\n![local](file://${secret})\n\n[bad](javascript:window.__p6Executed=true)\n\n<iframe src="file://${secret}"></iframe>\n\n![registered chart](chart.png)\n`;
    const longText =
      'LONG_MESSAGE_BEGIN\n\n' +
      hostile +
      '一段可分页的长消息。中文与 emoji 🌱 均保留。\n\n'.repeat(3200) +
      '\nLONG_MESSAGE_END';
    try {
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      let page = app.page;
      await configure(page);
      const remoteRequests = [];
      page.on('request', (request) => {
        if (request.url().includes('p6-untrusted.invalid') || request.url() === `file://${secret}`)
          remoteRequests.push(request.url());
      });
      await page.evaluate(() => {
        window.__p6Executed = false;
      });
      const ls = { tool: { name: 'ls', args: { path: '.' } } };
      fixture.set(
        {
          tool: {
            name: 'write',
            args: {
              path: 'chart.py',
              content:
                'from PIL import Image\nImage.new("RGB", (32,32), (23,160,95)).save("chart.png")\n',
            },
          },
        },
        { tool: { name: 'bash', args: { command: 'python3 chart.py' } } },
        { tool: { name: 'write', args: { path: 'report.md', content: hostile } } },
        ...Array.from({ length: 8 }, () => ls),
        { text: longText },
      );
      const sessionId = await submit(page, 'FIRST_USER_MESSAGE_PAGINATION');
      const first = await settled(page, sessionId);
      assert.equal(first.state, 'completed');
      await published(page, sessionId);
      await openPreview(page, '预览');
      await page
        .locator('.artifact-markdown')
        .getByRole('heading', { name: 'Safe report heading' })
        .waitFor();
      const image = page
        .locator('.artifact-markdown')
        .getByRole('img', { name: 'registered chart', exact: true });
      await until(
        () => image.evaluate((element) => element.complete && element.naturalWidth === 32),
        'registered PNG decoded',
      );
      assert.equal(
        await page
          .locator(
            '.artifact-markdown script,.artifact-markdown iframe,.artifact-markdown object,.artifact-markdown [onerror]',
          )
          .count(),
        0,
      );
      await page.getByRole('button', { name: '展开结果面板', exact: true }).click();
      assert(
        (await page.getByRole('complementary', { name: '结果面板' }).boundingBox()).width > 500,
      );
      await page.getByRole('button', { name: '缩小结果面板', exact: true }).click();
      const message = page
        .locator('.history-message.assistant')
        .filter({ has: page.locator('.markdown-body', { hasText: 'LONG_MESSAGE_BEGIN' }) });
      assert.equal(await message.locator('.markdown-body .paged-text').count(), 0);
      await page
        .locator('.history-message.assistant .markdown-body')
        .filter({ hasText: 'LONG_MESSAGE_END' })
        .waitFor();
      assert(
        first.messages.some((m) =>
          m.blocks.some((b) => b.type === 'text' && b.text.endsWith('LONG_MESSAGE_END')),
        ),
      );
      fixture.set(...Array.from({ length: 8 }, () => ls), { text: 'SECOND_RUN_END' });
      await page.getByRole('textbox', { name: '分析需求' }).fill('Continue this conversation.');
      await page.getByRole('button', { name: '发送分析需求', exact: true }).click();
      await until(async () => {
        const value = await rpc(page, { type: 'runtime.snapshot', sessionId });
        return value?.runId !== first.runId && value?.state === 'completed';
      }, 'second run ended');
      assert.equal(await page.locator('.history-pagination').count(), 0);
      const chat = page.locator('.history-list');
      await chat.hover();
      await page.mouse.wheel(0, -1000000);
      const load = page.getByRole('button', { name: '加载更早消息', exact: true });
      while (await load.isVisible()) {
        await load.click();
        await chat.hover();
        await page.mouse.wheel(0, -1000000);
      }
      await page
        .getByLabel('会话消息')
        .getByText('FIRST_USER_MESSAGE_PAGINATION', { exact: true })
        .waitFor();
      await page.getByRole('button', { name: '回到最新消息', exact: true }).click();
      await page.getByText('SECOND_RUN_END', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.__p6Executed), false);
      assert.deepEqual(remoteRequests, []);
      assert(!(await page.locator('body').innerText()).includes('PRIVATE_FILE_MUST_NOT_RENDER'));
      assert.deepEqual(app.errors, []);
      await app.stop();
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      page = app.page;
      await page.getByText('SECOND_RUN_END', { exact: true }).waitFor();
      const restored = await rpc(page, { type: 'runtime.snapshot', sessionId });
      assert(
        restored.messages.some((m) =>
          m.blocks.some((b) => b.type === 'text' && b.text.endsWith('LONG_MESSAGE_END')),
        ),
      );
      assert((await page.locator('.history-message').count()) <= 20);
      assert.deepEqual(app.errors, []);
      return {
        scriptExecution: false,
        remoteOrArbitraryFileRequests: remoteRequests.length,
        pngDecoded: true,
        expandedReport: true,
        longTextEndAccessible: true,
        conversationPagination: true,
        fullLongMessageRestored: true,
      };
    } finally {
      await app?.stop();
      await fixture.close();
    }
  },
};
