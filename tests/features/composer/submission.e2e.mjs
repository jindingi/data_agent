import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { modelFixture } from '../../../scripts/test/model-fixture.mjs';
import { configure, settled, rpc } from '../../support/desktop.mjs';

export const cases = {
  async 'composer.submission'({ dir }) {
    const root = join(dir, 'ux-drafts'),
      csv = join(root, 'data.csv');
    mkdirSync(root, { recursive: true });
    writeFileSync(csv, 'x,y\n1,2\n');
    const fixture = await modelFixture();
    let app = await startApp(join(root, 'app'), {
      pickFiles: [csv],
      testModelBaseUrl: fixture.baseUrl,
    });
    try {
      let page = app.page;
      for (let i = 0; i < 5; i++)
        await page.getByRole('button', { name: '新会话', exact: true }).click();
      await page.getByRole('button', { name: '添加 CSV 文件', exact: true }).click();
      await page.getByRole('button', { name: '移除文件 data.csv', exact: true }).waitFor();
      await page.getByRole('textbox', { name: '分析需求' }).fill('draft survives restart');
      await page.getByRole('button', { name: '发送分析需求', exact: true }).click();
      await page.getByRole('alert').waitFor();
      assert.equal((await rpc(page, { type: 'sessions.list' })).length, 0);
      assert.deepEqual(readdirSync(join(root, 'app/data/workspace')), []);
      assert.equal(
        await page.getByRole('textbox', { name: '分析需求' }).inputValue(),
        'draft survives restart',
      );
      await app.stop();
      app = await startApp(join(root, 'app'), {
        pickFiles: [csv],
        testModelBaseUrl: fixture.baseUrl,
      });
      page = app.page;
      assert.equal(
        await page.getByRole('textbox', { name: '分析需求' }).inputValue(),
        'draft survives restart',
      );
      await page.getByRole('button', { name: '移除文件 data.csv', exact: true }).waitFor();
      await configure(page);
      fixture.set({ text: 'ATTACHMENT_ACCEPTED' });
      await page.getByRole('button', { name: '发送分析需求', exact: true }).click();
      const id = await until(
        () => page.getByTestId('session-title').getAttribute('data-session-id'),
        'first send creates session',
      );
      assert.equal((await settled(page, id)).state, 'completed');
      assert.equal((await rpc(page, { type: 'sessions.list' })).length, 1);
      assert.equal(await page.getByRole('textbox', { name: '分析需求' }).inputValue(), '');
      assert.equal(await page.locator('.attachment-list').count(), 0);
      await page.getByLabel('本次附件').getByText('data.csv', { exact: true }).waitFor();
      assert(fixture.requests.some((r) => JSON.stringify(r.messages).includes(csv)));
      assert(
        fixture.requests[0].messages.some(
          (m) => m.role === 'user' && JSON.stringify(m.content).includes(csv),
        ),
      );
      const history = await rpc(page, { type: 'runtime.snapshot', sessionId: id });
      const inputId = history.inputs[0].inputId;
      const retry = {
        type: 'conversation.submit',
        input: { inputId, kind: 'prompt', text: 'draft survives restart', paths: [csv] },
      };
      const receipt = await rpc(page, retry);
      assert.equal(receipt.sessionId, id);
      assert.equal(fixture.requests.length, 1);
      const conflict = await page.evaluate((command) => window.dataAgent.request(command), {
        ...retry,
        input: { ...retry.input, text: 'different' },
      });
      assert.equal(conflict.ok, false);
      await page.getByRole('button', { name: '新会话', exact: true }).click();
      assert.equal((await rpc(page, { type: 'sessions.list' })).length, 1);
      assert.equal(await page.getByRole('textbox', { name: '分析需求' }).inputValue(), '');
      assert.deepEqual(app.errors, []);
      return {
        noEmptySessions: true,
        failedPreflightRetainsDraft: true,
        restartDraft: true,
        messageAttachments: true,
        stableRetry: true,
      };
    } finally {
      await app.stop();
      await fixture.close();
    }
  },
};
