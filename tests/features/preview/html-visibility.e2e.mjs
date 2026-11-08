import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { startDevApp } from '../../../scripts/test/dev-harness.mjs';
import { modelFixture } from '../../../scripts/test/model-fixture.mjs';
import { configure, submit, settled, rpc, openWorkspaceFile } from '../../support/desktop.mjs';
import { reportFixture } from '../../support/report-fixture.mjs';
import { reportViewProbe } from '../../support/report-view-probe.mjs';

async function scenario({ dir }, dev = false) {
  const root = join(dir, dev ? 'html-visibility-dev' : 'html-visibility');
  const fixture = await modelFixture();
  const native = reportViewProbe(root);
  let app;
  try {
    app = await (dev ? startDevApp : startApp)(root, {
      testModelBaseUrl: fixture.baseUrl,
      nodeOptions: native.nodeOptions,
    });
    const page = app.page;
    await configure(page);
    fixture.set({
      text: 'Completed synthetic analysis.',
      usage: {
        prompt_tokens: 8,
        completion_tokens: 4,
        total_tokens: 12,
      },
    });
    const id = await submit(page, 'Complete this synthetic analysis.');
    assert.equal((await settled(page, id)).state, 'completed');
    const usage = page.getByRole('button', { name: '查看本轮用量', exact: true });
    await usage.waitFor();
    const popup = page.getByRole('dialog', {
      name: '本轮用量详情',
      exact: true,
      includeHidden: true,
    });
    assert.equal(await popup.count(), 1, 'completed turns keep a native popover in the DOM');
    assert.equal(await popup.isVisible(), false);
    const session = (await rpc(page, { type: 'sessions.list' })).find((s) => s.id === id);
    writeFileSync(join(session.workspace, 'report.html'), reportFixture());
    await openWorkspaceFile(page, 'report.html');
    const report = await until(
      () =>
        app.browser
          .contexts()
          .flatMap((c) => c.pages())
          .find((p) => p.url().startsWith('data-report:')),
      'report document',
    );
    await report.waitForLoadState('load');
    // Canvas creation alone passed the old tests even while the native report view stayed hidden.
    assert.equal(await report.locator('canvas').count(), 1);
    const visible = () => native.matches(true);
    await until(
      visible,
      'report visible beside a completed turn with a closed usage popover',
      5000,
    );
    await report.getByLabel('地区').selectOption('east');
    assert.equal(await report.locator('#total').textContent(), '30');

    await usage.click();
    await popup.waitFor({ state: 'visible' });
    await until(() => native.matches(false), 'open usage popover hides native report');
    await page.keyboard.press('Escape');
    await popup.waitFor({ state: 'hidden' });
    assert(await usage.evaluate((node) => document.activeElement === node));
    // Focus restoration can open the trigger's tooltip, which also covers the native view.
    await page.mouse.move(10, 10);
    await page.getByRole('textbox', { name: '分析需求' }).focus();
    await until(visible, 'native popover close restores the report');
    assert.equal(await report.locator('#total').textContent(), '30');

    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('dialog', { name: '设置', exact: true }).waitFor();
    await until(() => native.matches(false), 'visible settings dialog hides native report');
    await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
    await page.mouse.move(10, 10);
    await page.getByRole('textbox', { name: '分析需求' }).focus();
    await until(visible, 'closed dialogs do not hide report');
    assert.equal(await report.locator('#total').textContent(), '30');
    await report.screenshot({
      path: join(dir, `html-visibility-${dev ? 'dev' : 'built'}-report.png`),
    });
    await page.screenshot({ path: join(dir, `html-visibility-${dev ? 'dev' : 'built'}-host.png`) });
    assert.deepEqual(app.errors, []);
    return { dev, completedTurn: true, nativeViewVisible: true, popoverCloseRestoresReport: true };
  } finally {
    await app?.stop();
    await fixture.close();
  }
}

export const cases = {
  'preview.html-visibility': (context) => scenario(context),
  'preview.html-visibility-dev': (context) => scenario(context, true),
};
