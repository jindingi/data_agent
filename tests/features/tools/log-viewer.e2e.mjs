import { openExecutionProcesses } from '../../support/desktop.mjs';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { modelFixture } from '../../../scripts/test/model-fixture.mjs';
import { rpc, configure, submit, settled } from '../../support/desktop.mjs';

export const cases = {
  async 'tools.log-viewer'({ dir }) {
    const root = resolve(dir, 'p6-log-ui'),
      fixture = await modelFixture();
    let app;
    try {
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      const page = app.page;
      await configure(page);
      fixture.set(
        {
          tool: {
            name: 'bash',
            args: {
              command: 'python3 -c \'print("日志正文" * 20000); print("LOG_END_SENTINEL")\'',
            },
          },
        },
        { text: 'Large tool output delivered.' },
      );
      const sessionId = await submit(page, 'Produce a large tool log.');
      const final = await settled(page, sessionId);
      const tool = final.tools.find((t) => t.name === 'bash');
      assert(tool);
      assert(tool.output.includes('截断'));
      const card = page.locator(`[data-tool-id="${tool.id}"]`);
      await openExecutionProcesses(page);
      await card.locator('summary').click();
      await card.getByRole('button', { name: '查看完整日志', exact: true }).click();
      const content = page.getByTestId('full-tool-log');
      await content.waitFor();
      let text = await content.innerText(),
        pages = 1;
      while (await page.getByRole('button', { name: '下一页日志', exact: true }).isEnabled()) {
        const before = await content.innerText();
        await page.getByRole('button', { name: '下一页日志', exact: true }).click();
        await until(
          () => page.getByRole('button', { name: '刷新日志', exact: true }).isEnabled(),
          'log loaded',
        );
        const next = await content.innerText();
        text += next;
        pages++;
        assert(pages < 20);
        assert(before || next);
      }
      assert(text.includes('LOG_END_SENTINEL'));
      assert(pages > 3);
      assert(!text.includes('\ufffd'));
      await page.getByRole('button', { name: '上一页日志', exact: true }).click();
      await until(
        () => page.getByRole('button', { name: '下一页日志', exact: true }).isEnabled(),
        'previous page loaded',
      );
      const { logs: records } = await rpc(page, {
        type: 'logs.list',
        sessionId,
        toolCallId: tool.id,
      });
      assert.equal(records.length, 1);
      assert.deepEqual(app.errors, []);
      return {
        actualLogPages: pages,
        endBeyondStreamTruncationVisible: true,
        utf8Preserved: true,
      };
    } finally {
      await app?.stop();
      await fixture.close();
    }
  },
};
