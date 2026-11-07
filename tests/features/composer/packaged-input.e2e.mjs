import { workspaceFiles } from '../../support/desktop.mjs';
import { openExecutionProcesses } from '../../support/desktop.mjs';
import { openPreview } from '../../support/desktop.mjs';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { modelFixture } from '../../../scripts/test/model-fixture.mjs';
import { configure, rpc, settled } from '../../support/desktop.mjs';

const taskTool = (name, args) => ({ tool: { name, args } });

async function listing(page, sessionId) {
  return until(async () => {
    const files = await workspaceFiles(page, sessionId);
    return files.length ? files : null;
  }, 'workspace files available');
}
export const cases = {
  async 'composer.packaged-input'({ dir }) {
    const root = resolve(dir, 'p7-theme-input');
    mkdirSync(root, { recursive: true });
    const fixture = await modelFixture();
    const options = { packaged: true, testModelBaseUrl: fixture.baseUrl };
    let app;
    try {
      app = await startApp(join(root, 'app'), options);
      let page = app.page;
      const theme = () => page.locator('html').getAttribute('data-theme');
      assert.equal(await theme(), 'dark');
      const darkBackground = await page
        .locator('body')
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      await page.screenshot({ path: join(root, 'dark-welcome.png') });
      await page.getByRole('button', { name: '切换到浅色模式', exact: true }).click();
      assert.equal(await theme(), 'light');
      assert.notEqual(
        await page.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor),
        darkBackground,
      );
      await delay(250); // Let the existing button/card color transitions settle before visual review.
      await page.screenshot({ path: join(root, 'light-welcome.png') });
      await page.reload();
      assert.equal(await theme(), 'light');
      await configure(page);
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.screenshot({ path: join(root, 'light-settings.png') });
      await page.getByRole('button', { name: '关闭对话框', exact: true }).click();

      const input = page.getByRole('textbox', { name: '分析需求' });
      await input.fill('   ');
      await input.press('Enter');
      await input.fill('第一行');
      await input.press('Shift+Enter');
      await input.press('Space');
      assert.equal(await input.inputValue(), '第一行\n ');
      // Synthetic composition events exercise renderer guards; submission itself uses real CDP keyboard input.
      await input.evaluate((el) => {
        el.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }),
        );
        el.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, keyCode: 229 }),
        );
        el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
        el.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, repeat: true }),
        );
      });
      await delay(200);
      assert.equal(fixture.requests.length, 0);
      assert.equal(await input.inputValue(), '第一行\n ');
      const markdown =
        '# 主题预览\n\n中文 **正文** 与 [文件](report.md)。\n\n|地区|金额|\n|---|---|\n|北区|10|\n\n```python\nprint("hello")\n```\n';
      fixture.set(taskTool('write', { path: 'report.md', content: markdown }), { text: markdown });
      await input.fill('第一行');
      await input.press('Shift+Enter');
      await input.press('Space');
      await input.press('a');
      const expected = '第一行\n a';
      assert.equal(await input.inputValue(), expected);
      await input.press('Enter');
      const id = await until(
        () => page.getByTestId('session-title').getAttribute('data-session-id'),
        'keyboard-created session',
      );
      const first = await settled(page, id);
      assert.equal(first.state, 'completed');
      assert.equal(fixture.requests.length, 2);
      assert.equal(await input.inputValue(), '');
      assert(
        fixture.requests[0].messages.some(
          (m) =>
            m.role === 'user' &&
            (typeof m.content === 'string'
              ? m.content
              : m.content.map((b) => b.text ?? '').join('\n')
            ).includes(expected),
        ),
      );
      await listing(page, id);
      await openPreview(page, '预览');
      await page.locator('.artifact-markdown').getByRole('heading', { name: '主题预览' }).waitFor();
      await openExecutionProcesses(page);
      await page.locator('.tool-card summary').first().click();
      await page.screenshot({ path: join(root, 'light-report.png') });
      await page.getByRole('button', { name: '切换到深色模式', exact: true }).click();
      await delay(250);
      await page.screenshot({ path: join(root, 'dark-report.png') });
      await page.getByRole('button', { name: '切换到浅色模式', exact: true }).click();
      assert.deepEqual(app.errors, []);
      await app.stop();

      app = await startApp(join(root, 'app'), options);
      page = app.page;
      assert.equal(await theme(), 'light');
      fixture.set({ text: 'Compatibility shortcut delivered.' });
      const restoredInput = page.getByRole('textbox', { name: '分析需求' });
      await restoredInput.fill('兼容原有快捷键');
      await restoredInput.press('Meta+Enter');
      const second = await until(async () => {
        const v = await rpc(page, { type: 'runtime.snapshot', sessionId: id });
        return v?.runId !== first.runId && v?.state === 'completed' ? v : null;
      }, 'compatibility shortcut completed');
      assert.notEqual(second.runId, first.runId);
      assert.equal(fixture.requests.length, 3);
      await page.getByRole('button', { name: '切换到深色模式', exact: true }).click();
      await page.reload();
      assert.equal(await theme(), 'dark');
      assert.deepEqual(app.errors, []);
      return {
        packaged: true,
        lightAndDark: true,
        themeReloadAndRestart: true,
        enterSends: true,
        shiftEnterNewline: true,
        spacePreserved: true,
        imeAndRepeatDoNotSend: true,
        blankDoesNotSend: true,
        metaEnterCompatible: true,
        requests: fixture.requests.length,
      };
    } finally {
      await app?.stop();
      await fixture.close();
    }
  },
};
