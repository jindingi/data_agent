import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startApp, until } from '../../scripts/test/harness.mjs';
import { createStoredSession, openPreview, rpc } from './desktop.mjs';
import { reportFixture } from './report-fixture.mjs';
import { openOfflineReport } from './offline-report.mjs';

export async function htmlPreviewScenario({ dir }, packaged = false) {
  const target = join(dir, 'exported-report.html');
  const app = await startApp(join(dir, 'html-app'), { saveFile: target, packaged });
  const pages = () => app.browser.contexts().flatMap((context) => context.pages());
  try {
    const session = await createStoredSession(app.page);
    const html = reportFixture('narrative');
    writeFileSync(join(session.workspace, 'report.html'), html);
    writeFileSync(join(session.workspace, 'second.html'), reportFixture('comparison'));
    await openPreview(app.page, '文件');
    await app.page.getByRole('button', { name: '刷新工作区', exact: true }).click();
    await app.page.getByRole('button', { name: 'report.html', exact: true }).click();
    let report = await until(
      () => pages().find((p) => p.url().startsWith('data-report:')),
      'interactive document',
    );
    await report.locator('canvas').waitFor();
    await report.getByLabel('地区').selectOption('east');
    assert.equal(await report.locator('#total').textContent(), '30');
    await app.page.getByRole('button', { name: '查看源码', exact: true }).click();
    await app.page.locator('.source-code').waitFor();
    await app.page.getByRole('button', { name: '阅读视图', exact: true }).click();
    assert.equal(await report.locator('#total').textContent(), '30');
    await app.page.getByRole('button', { name: '关闭结果面板', exact: true }).click();
    await openPreview(app.page, '预览');
    assert.equal(await report.locator('#total').textContent(), '30');
    await app.page.getByRole('button', { name: '设置', exact: true }).click();
    await app.page.getByRole('dialog').waitFor();
    await app.page.getByRole('button', { name: '关闭对话框', exact: true }).click();
    assert.equal(await report.locator('#total').textContent(), '30');
    for (const [width, height] of [
      [1440, 900],
      [1100, 720],
      [940, 650],
    ]) {
      await app.page.setViewportSize({ width, height });
      for (const theme of ['dark', 'light']) {
        await app.page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
        await until(
          () =>
            app.page
              .locator('.html-report-surface')
              .evaluate((e) => e.getBoundingClientRect().height > 0),
          'report layout',
        );
        await app.page.screenshot({ path: join(dir, `html-host-${width}-${theme}.png`) });
        await report.screenshot({ path: join(dir, `html-report-${width}-${theme}.png`) });
      }
    }
    await report.getByRole('link', { name: '跳至尾部' }).click();
    await until(() => report.evaluate(() => window.scrollY > 0), 'report anchor and scroll');
    const scroll = await report.evaluate(() => window.scrollY);
    await app.page.getByRole('button', { name: '查看源码', exact: true }).click();
    await app.page.getByRole('button', { name: '阅读视图', exact: true }).click();
    assert.equal(await report.evaluate(() => window.scrollY), scroll);
    const previous = report;
    const previousUrl = previous.url();
    await app.page.getByRole('button', { name: '刷新工作区', exact: true }).click();
    await until(() => previous.isClosed(), 'explicit refresh closes old document');
    report = await until(
      () => pages().find((p) => p.url().startsWith('data-report:') && p.url() !== previousUrl),
      'refreshed report',
    );
    await report.locator('#total').waitFor();
    assert.equal(await report.locator('#total').textContent(), '60');
    await app.page.getByRole('button', { name: '另存文件', exact: true }).click();
    await app.page.getByRole('status').filter({ hasText: '文件已另存' }).waitFor();
    assert.equal(readFileSync(target, 'utf8'), html);
    await app.page.getByRole('button', { name: '关闭结果面板', exact: true }).click();
    const newSession = await createStoredSession(app.page);
    const entries = await rpc(app.page, { type: 'workspace.list', sessionId: session.id });
    const entry = entries.entries.find((e) => e.name === 'report.html');
    const denied = await app.page.evaluate(
      async ({ id, entryId }) =>
        window.dataAgent.request({
          type: 'report.open',
          id: crypto.randomUUID(),
          sessionId: id,
          entryId,
        }),
      { id: newSession.id, entryId: entry.id },
    );
    assert.equal(denied.ok, false);
    // The exported file operates independently of the application protocol and original source paths.
    const browser = await openOfflineReport(join(dir, 'offline-report'), target);
    try {
      const exported = browser.page;
      await exported.getByLabel('地区').selectOption('east');
      assert.equal(await exported.locator('#total').textContent(), '30');
    } finally {
      await browser.close();
    }
    assert.deepEqual(app.errors, []);
    return {
      isolatedPreview: true,
      sourceAndHiddenStatePreserved: true,
      exportOffline: true,
      sizes: 3,
      themes: 2,
      packaged,
    };
  } finally {
    await app.stop();
  }
}
