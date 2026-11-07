import { mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startApp, until } from '../../scripts/test/harness.mjs';
import { modelFixture } from '../../scripts/test/model-fixture.mjs';
import { configure, submit, settled, rpc, createStoredSession } from '../support/desktop.mjs';

export const cases = {
  async 'UX-DELETE-VISIBILITY'({ dir }) {
    const app = await startApp(join(dir, 'ux-delete-visibility'));
    try {
      const page = app.page;
      await createStoredSession(page);
      const measurements = [];
      for (const theme of ['light', 'dark']) {
        const toggle = page.getByRole('button', {
          name: theme === 'light' ? '切换到浅色模式' : '切换到深色模式',
        });
        if (await toggle.count()) await toggle.click();
        await page.getByRole('button', { name: '会话操作', exact: true }).click();
        await page.getByRole('menuitem', { name: '删除会话', exact: true }).click();
        const confirm = page.getByRole('button', { name: '确认删除会话', exact: true });
        await until(() => confirm.isEnabled(), 'deletion preview ready');
        for (const state of ['normal', 'hover', 'focus']) {
          if (state === 'hover') await confirm.hover();
          if (state === 'focus') {
            await page.mouse.move(0, 0);
            await page.getByRole('button', { name: '取消', exact: true }).focus();
            await page.keyboard.press('Tab');
            assert(await confirm.evaluate((n) => n === document.activeElement));
          }
          await confirm.evaluate(async (n) => {
            await Promise.all(n.getAnimations().map((animation) => animation.finished));
          });
          // DOM visibility/clickability alone misses white text on a white dialog.
          const colors = await confirm.evaluate((n) => {
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = 1;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, 1, 1);
            const ancestors = [];
            for (let el = n; el; el = el.parentElement) ancestors.unshift(el);
            for (const el of ancestors) {
              ctx.fillStyle = getComputedStyle(el).backgroundColor;
              ctx.fillRect(0, 0, 1, 1);
            }
            const background = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3);
            ctx.fillStyle = getComputedStyle(n).color;
            ctx.fillRect(0, 0, 1, 1);
            return {
              background,
              foreground: [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3),
              cssBackground: getComputedStyle(n).backgroundColor,
            };
          });
          const luminance = (rgb) =>
            rgb.reduce((sum, value, i) => {
              const c = value / 255;
              return (
                sum +
                (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4) *
                  [0.2126, 0.7152, 0.0722][i]
              );
            }, 0);
          const a = luminance(colors.background),
            b = luminance(colors.foreground);
          const contrast = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
          measurements.push({ theme, state, ...colors, contrast });
          writeFileSync(join(dir, 'delete-contrast.json'), JSON.stringify(measurements, null, 2));
          await page
            .getByRole('dialog')
            .screenshot({ path: join(dir, `delete-${theme}-${state}.png`) });
          assert(
            contrast >= 4.5,
            `${theme}/${state} confirm contrast ${contrast}: ${JSON.stringify(colors)}`,
          );
        }
        await page.getByRole('button', { name: '取消', exact: true }).click();
        assert.equal((await rpc(page, { type: 'sessions.list' })).length, 1);
      }
      assert.deepEqual(app.errors, []);
      return { measurements, cancelPreservesSession: true };
    } finally {
      await app.stop();
    }
  },
  async 'UX-DRAFTS'({ dir }) {
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
      assert.equal((await rpc(page, { type: 'sessions.open', sessionId: id })).files.length, 1);
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
  async 'UX-READING'({ dir }) {
    const fixture = await modelFixture();
    const app = await startApp(join(dir, 'ux-reading'), { testModelBaseUrl: fixture.baseUrl });
    try {
      const page = app.page;
      await configure(page);
      const report =
        '# 阅读验证\n\n' +
        Array.from(
          { length: 60 },
          (_, i) =>
            `## 第 ${i + 1} 节\n\n正文用于验证可达性和滚动稳定性。\n\n| 列 A | 列 B |\n| --- | --- |\n| 中文 | ${'long-value-'.repeat(30)} |\n\n`,
        ).join('') +
        '\nREPORT-END-MARKER\n';
      fixture.set(
        { tool: { name: 'write', args: { path: 'report.md', content: report } } },
        { text: report },
      );
      const id = await submit(page, '生成 report.md');
      assert.equal((await settled(page, id)).state, 'completed');
      await until(
        async () => (await rpc(page, { type: 'artifacts.list', sessionId: id })).files.length > 0,
        'artifact ready',
      );
      await page.getByRole('button', { name: '切换结果面板' }).click();
      await page.getByRole('tab', { name: '预览', exact: true }).click();
      await page.locator('.artifact-markdown').waitFor();
      for (const [width, height] of [
        [1440, 900],
        [1280, 800],
        [940, 650],
      ]) {
        await page.setViewportSize({ width, height });
        for (const theme of ['light', 'dark']) {
          const toggle = page.getByRole('button', {
            name: theme === 'light' ? '切换到浅色模式' : '切换到深色模式',
          });
          if (await toggle.count()) {
            await page.getByRole('button', { name: '关闭结果面板' }).click();
            await toggle.click();
            await page.getByRole('button', { name: '切换结果面板' }).click();
          }
          const pane = page.locator('.artifact-scroll');
          await pane.focus();
          await page.keyboard.press('Control+End');
          // Native wheel scrolling must move the actual preview, independently of chat.
          const before = await page.locator('.history-list').evaluate((n) => n.scrollTop);
          await pane.hover();
          for (let n = 0; n < 8; n++) await page.mouse.wheel(0, 8000);
          await until(
            () => pane.evaluate((n) => n.scrollHeight - n.scrollTop - n.clientHeight < 4),
            'preview end reached',
          );
          const marker = pane.getByText('REPORT-END-MARKER', { exact: true });
          const box = await marker.boundingBox();
          assert(box && box.y >= 0 && box.y + box.height <= height, 'report tail in viewport');
          assert.equal(await page.locator('.history-list').evaluate((n) => n.scrollTop), before);
          assert(
            await page
              .locator('.artifact-toolbar')
              .evaluate((n) => n.getBoundingClientRect().height + 52 <= 120),
          );
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          await page.screenshot({ path: join(dir, `ux-${width}-${theme}.png`) });
        }
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      const splitter = page.getByRole('separator', { name: '调整预览宽度' });
      await splitter.focus();
      const initial = await page.locator('.result-panel').evaluate((n) => n.clientWidth);
      await page.keyboard.press('ArrowLeft');
      assert((await page.locator('.result-panel').evaluate((n) => n.clientWidth)) > initial);
      const b = await splitter.boundingBox();
      await page.mouse.move(b.x + 4, b.y + 150);
      await page.mouse.down();
      await page.mouse.move(b.x - 70, b.y + 150);
      await page.mouse.up();
      assert((await page.locator('.result-panel').evaluate((n) => n.clientWidth)) > initial + 32);
      const version = await page.getByLabel('选择预览文件').inputValue();
      await page.getByRole('button', { name: '展开结果面板' }).click();
      await page.getByRole('button', { name: '缩小结果面板' }).click();
      assert.equal(await page.getByLabel('选择预览文件').inputValue(), version);
      await page.getByRole('button', { name: '关闭结果面板' }).hover();
      await page.getByRole('tooltip', { name: '关闭结果面板' }).waitFor();
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: '关闭结果面板' }).click();
      const chat = page.locator('.history-list');
      await chat.hover();
      await page.mouse.wheel(0, -1500);
      await page.getByRole('button', { name: '回到最新消息' }).waitFor();
      assert.equal(await page.locator('.history-pagination').count(), 0);
      assert.equal(
        await page.locator('.history-message.assistant > .markdown-body .paged-text').count(),
        0,
      );
      await page.getByRole('button', { name: '回到最新消息' }).click();
      assert.deepEqual(app.errors, []);
      return {
        reportWheelEnd: true,
        independentScroll: true,
        resizePointerAndKeyboard: true,
        themesAndViewports: 6,
        continuousMarkdown: true,
        tooltip: true,
      };
    } finally {
      await app.stop();
      await fixture.close();
    }
  },
};
