import { openPreview } from '../../support/desktop.mjs';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { modelFixture } from '../../../scripts/test/model-fixture.mjs';
import { rpc, configure, submit, settled } from '../../support/desktop.mjs';

async function send(page, text, kind) {
  if (kind) await page.getByLabel('运行中输入方式').selectOption(kind);
  await page.getByRole('textbox', { name: '分析需求' }).fill(text);
  await page.getByRole('button', { name: '发送分析需求', exact: true }).click();
  await until(
    () =>
      page
        .getByRole('textbox', { name: '分析需求' })
        .inputValue()
        .then((value) => value === ''),
    'input accepted',
  );
}

async function listing(page, sessionId, count) {
  return until(async () => {
    const value = await rpc(page, { type: 'artifacts.list', sessionId });
    return value.versions.length === count && value.versions.every((v) => v.state === 'published')
      ? value
      : null;
  }, 'all versions published');
}

const writeReport = (content) => ({
  tool: { name: 'write', args: { path: 'report.md', content } },
});
export const cases = {
  async 'conversation.multiturn'({ dir }) {
    const root = resolve(dir, 'p5-multiturn'),
      fixture = await modelFixture();
    let app;
    try {
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      const page = app.page;
      await configure(page);
      fixture.set(writeReport('# First report'), { text: 'First delivery complete.' });
      const sessionId = await submit(page, 'Create first report.'),
        first = await settled(page, sessionId);
      assert.equal(first.state, 'completed');
      const before = await listing(page, sessionId, 1),
        old = before.files.find((f) => f.relativePath === 'report.md');
      await openPreview(page, '预览');
      await page.getByRole('heading', { name: 'First report', exact: true }).waitFor();
      fixture.set(writeReport('# Second report'), { text: 'Second delivery complete.' });
      await send(page, 'Continue from previous delivery and create a new report.');
      const second = await until(async () => {
        const s = await rpc(page, { type: 'runtime.snapshot', sessionId });
        return s?.runId !== first.runId && s?.state === 'completed' ? s : null;
      }, 'second run completed');
      const after = await listing(page, sessionId, 1),
        reports = after.files.filter((f) => f.relativePath === 'report.md');
      assert.notEqual(second.runId, first.runId);
      assert.equal(reports.length, 1);
      assert.equal(first.outputDirectory, second.outputDirectory);
      assert.equal(readFileSync(old.path, 'utf8'), '# Second report');
      assert.notEqual(after.files.find((f) => f.id === old.id).sha256, old.sha256);
      assert.equal(
        readFileSync(join(second.outputDirectory, 'report.md'), 'utf8'),
        '# Second report',
      );
      assert(
        fixture.requests
          .at(-1)
          .messages.some(
            (m) => m.role === 'user' && JSON.stringify(m.content).includes('Create first report.'),
          ),
      );
      assert.equal(second.messages.filter((m) => m.role === 'user').length, 2);
      await page.getByRole('heading', { name: 'Second report', exact: true }).waitFor();
      assert.equal(await page.getByLabel('选择产物版本').count(), 0);
      for (let i = 1; i < fixture.requests.length; i++)
        assert.deepEqual(
          fixture.requests[i].messages.slice(0, fixture.requests[i - 1].messages.length),
          fixture.requests[i - 1].messages,
        );
      assert(!existsSync(join(second.outputDirectory, 'runs')));
      await page.screenshot({ path: join(root, 'multiturn.png'), fullPage: true });
      assert.deepEqual(app.errors, []);
      return {
        distinctRuns: true,
        historyInActualRequest: true,
        sameWorkspaceAndUpdatedArtifact: true,
      };
    } finally {
      await app?.stop();
      await fixture.close();
    }
  },
};
