import { configure, selectSession, rpc, openPreview, settled } from '../../support/desktop.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { modelFixture } from '../../../scripts/test/model-fixture.mjs';
export const cases = {
  async 'composer.input-references'({ dir }) {
    const root = join(dir, 'input-paths');
    mkdirSync(root, { recursive: true });
    const file = join(root, '数据.csv'),
      raw = Buffer.from([0xff, 0, 0x22, 0x0a]);
    writeFileSync(file, raw);
    const fixture = await modelFixture();
    let app;
    try {
      app = await startApp(join(root, 'app'), {
        pickFiles: [file],
        testModelBaseUrl: fixture.baseUrl,
      });
      await configure(app.page);
      fixture.set({ text: 'Accepted original path.' });
      await app.page.getByRole('button', { name: '添加 CSV 文件', exact: true }).click();
      await app.page.getByRole('textbox', { name: '分析需求' }).fill('Remember attached path.');
      await app.page.getByRole('button', { name: '发送分析需求', exact: true }).click();
      const id = await until(
        () => app.page.getByTestId('session-title').getAttribute('data-session-id'),
        'accepted',
      );
      await settled(app.page, id);
      const { session } = await rpc(app.page, { type: 'sessions.open', sessionId: id });
      assert.deepEqual(readFileSync(file), raw);
      assert.deepEqual(readdirSync(session.workspace), []);
      await openPreview(app.page, '文件');
      await app.page.getByText('工作区暂无文件').waitFor();
      assert(fixture.requests.some((r) => JSON.stringify(r.messages).includes(file)));
      await app.stop();
      unlinkSync(file);
      app = await startApp(join(root, 'app'), { testModelBaseUrl: fixture.baseUrl });
      await selectSession(app.page, id);
      fixture.set({ text: 'No file read needed.' });
      await app.page
        .getByRole('textbox', { name: '分析需求' })
        .fill('Continue without reading the old file.');
      await app.page.getByRole('button', { name: '发送分析需求', exact: true }).click();
      await until(
        async () =>
          (await rpc(app.page, { type: 'runtime.snapshot', sessionId: id })).messages.some((m) =>
            m.blocks.some((b) => b.type === 'text' && b.text === 'No file read needed.'),
          ),
        'followup after source removed',
      );
      assert.deepEqual(readdirSync(session.workspace), []);
      return {
        originalPathOnly: true,
        noCsvParsing: true,
        missingHistoricalSourceDoesNotBlock: true,
      };
    } finally {
      await app?.stop();
      await fixture.close();
    }
  },
};
