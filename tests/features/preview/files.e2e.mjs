import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, unlinkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { modelFixture } from '../../../scripts/test/model-fixture.mjs';
import {
  configure,
  rpc,
  settled,
  openPreview,
  createStoredSession,
  selectSession,
} from '../../support/desktop.mjs';

export const cases = {
  async 'preview.files'({ dir }) {
    const root = join(dir, 'file-preview');
    mkdirSync(root, { recursive: true });
    const csv = join(root, 'input.csv');
    const input = '地区,说明\n上海,"含逗号,和\n换行"\n<img src=x onerror=alert(1)>,2\n';
    writeFileSync(csv, input);
    const large = join(root, 'large.csv');
    writeFileSync(large, 'x'.repeat(140000));
    const invalid = join(root, 'invalid.csv');
    writeFileSync(invalid, Buffer.from([0xff, 0xfe, 0x61]));
    const fixture = await modelFixture();
    const outputs = {
      'analysis.py':
        'import pandas as pd\n# 中文注释\nvalue = "<img src=x onerror=alert(1)>"\nprint(42)\n',
      'query.sql': 'SELECT region, SUM(amount) FROM sales GROUP BY region;\n',
      'settings.json': '{"地区":"上海","count":42}\n',
      'settings.yaml': 'region: 上海\ncount: 42\n',
      'data.csv': 'region,value\n上海,42\n',
      'script.js': 'const value = 42;\nconsole.log(value);\n',
      'report.md': '# 示例报告\n\n[查看代码](analysis.py)\n',
      'blob.bin': 'opaque data',
    };
    fixture.set(
      ...Object.entries(outputs).map(([path, content]) => ({
        tool: { name: 'write', args: { path, content } },
      })),
      { text: 'Files ready.' },
    );
    const app = await startApp(join(root, 'app'), {
      pickFiles: [csv, large, invalid],
      testModelBaseUrl: fixture.baseUrl,
    });
    try {
      const page = app.page;
      await configure(page);
      await page.getByRole('button', { name: '添加 CSV 文件', exact: true }).click();
      await page.getByRole('textbox', { name: '分析需求' }).fill('Generate preview fixtures.');
      await page.getByRole('button', { name: '发送分析需求', exact: true }).click();
      const id = await until(
        () => page.getByTestId('session-title').getAttribute('data-session-id'),
        'submitted',
      );
      assert.equal((await settled(page, id)).state, 'completed');
      const listing = await until(async () => {
        const value = await rpc(page, { type: 'artifacts.list', sessionId: id });
        return value.files.length === Object.keys(outputs).length ? value : null;
      }, 'all files registered');
      const refs = (await rpc(page, { type: 'sessions.open', sessionId: id })).files;
      const choose = async (name) => {
        await page
          .getByLabel('选择预览文件')
          .selectOption(listing.files.find((file) => file.relativePath === name).id);
        await until(
          () =>
            page
              .locator('.source-code')
              .textContent()
              .then((s) => s === outputs[name]),
          `preview ${name}`,
        );
      };
      await openPreview(page, '文件');
      await page.getByRole('button', { name: '预览 input.csv', exact: true }).click();
      await until(
        () =>
          page
            .locator('.source-code')
            .textContent()
            .then((s) => s === input),
        'raw input CSV',
      );
      assert.equal(await page.locator('.source-code img').count(), 0);
      await page.getByRole('button', { name: '复制当前内容', exact: true }).click();
      await page.getByRole('status').filter({ hasText: '已复制当前内容' }).waitFor();
      for (const name of [
        'analysis.py',
        'query.sql',
        'settings.json',
        'settings.yaml',
        'data.csv',
        'script.js',
      ]) {
        await choose(name);
        if (name !== 'data.csv')
          assert(
            (await page.locator('.source-code [class^="hljs-"]').count()) > 0,
            `${name} highlighted`,
          );
        assert.equal(await page.locator('.source-code img, .source-code script').count(), 0);
      }
      const report = listing.files.find((file) => file.relativePath === 'report.md');
      await page.getByLabel('选择预览文件').selectOption(report.id);
      await page.locator('.artifact-markdown').getByRole('heading', { name: '示例报告' }).waitFor();
      await page.getByRole('button', { name: '查看源码', exact: true }).click();
      assert.equal(await page.locator('.source-code').textContent(), outputs['report.md']);
      await page.getByRole('button', { name: '查看渲染', exact: true }).click();
      await page
        .locator('.artifact-markdown')
        .getByRole('button', { name: '查看代码', exact: true })
        .click();
      await until(
        () =>
          page
            .locator('.source-code')
            .textContent()
            .then((s) => s === outputs['analysis.py']),
        'relative code link',
      );
      for (const theme of ['light', 'dark']) {
        await page.getByRole('button', { name: '关闭结果面板' }).click();
        const toggle = page.getByRole('button', {
          name: theme === 'light' ? '切换到浅色模式' : '切换到深色模式',
        });
        if (await toggle.count()) await toggle.click();
        await openPreview(page);
        await page.screenshot({ path: join(dir, `source-${theme}.png`) });
      }
      const largeRef = refs.find((file) => file.name === 'large.csv');
      await page.getByLabel('选择预览文件').selectOption(`input:${largeRef.id}`);
      await page.getByRole('status').filter({ hasText: '仅展示文件开头' }).waitFor();
      assert.equal((await page.locator('.source-code').textContent()).length, 128 * 1024);
      await page.setViewportSize({ width: 940, height: 650 });
      const source = page.getByLabel('只读文件内容');
      await source.focus();
      await page.keyboard.press('ArrowRight');
      await until(
        () => source.evaluate((node) => node.scrollLeft > 0),
        'horizontal source scrolling',
      );
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: join(dir, 'source-narrow.png') });
      const invalidRef = refs.find((file) => file.name === 'invalid.csv');
      await page.getByLabel('选择预览文件').selectOption(`input:${invalidRef.id}`);
      await page
        .getByText('该文件不是有效的 UTF-8 文本，暂不支持此编码预览。', { exact: true })
        .waitFor();
      await page
        .getByLabel('选择预览文件')
        .selectOption(listing.files.find((file) => file.relativePath === 'blob.bin').id);
      await page
        .getByText('暂不支持此文件格式，可在 Finder 中定位后打开。', { exact: true })
        .waitFor();
      await page.getByRole('button', { name: '在 Finder 中定位文件', exact: true }).waitFor();
      // Validate session ownership, revoked references, symlinks and missing files through real IPC.
      await page.getByRole('button', { name: '关闭结果面板' }).click();
      const other = await createStoredSession(page);
      const inputRef = refs.find((file) => file.name === 'input.csv');
      for (const type of ['files.preview', 'files.copy', 'files.reveal']) {
        assert.equal(
          (
            await page.evaluate((command) => window.dataAgent.request(command), {
              type,
              sessionId: other.id,
              fileId: inputRef.id,
            })
          ).ok,
          false,
        );
      }
      assert.equal(
        (
          await page.evaluate((command) => window.dataAgent.request(command), {
            type: 'artifacts.preview',
            sessionId: other.id,
            artifactId: report.id,
          })
        ).ok,
        false,
      );
      await selectSession(page, id);
      unlinkSync(csv);
      symlinkSync(large, csv);
      assert.equal(
        (
          await page.evaluate((command) => window.dataAgent.request(command), {
            type: 'files.preview',
            sessionId: id,
            fileId: inputRef.id,
          })
        ).ok,
        false,
      );
      unlinkSync(csv);
      await openPreview(page, '文件');
      await page.getByRole('button', { name: '预览 input.csv', exact: true }).click();
      await page
        .getByRole('alert')
        .filter({ hasText: /ENOENT|不存在/ })
        .waitFor();
      await rpc(page, { type: 'files.remove', sessionId: id, fileId: inputRef.id });
      assert.equal(
        (
          await page.evaluate((command) => window.dataAgent.request(command), {
            type: 'files.preview',
            sessionId: id,
            fileId: inputRef.id,
          })
        ).ok,
        false,
      );
      const py = listing.files.find((file) => file.relativePath === 'analysis.py');
      writeFileSync(py.path, 'changed');
      assert.equal(
        (
          await page.evaluate((command) => window.dataAgent.request(command), {
            type: 'artifacts.preview',
            sessionId: id,
            artifactId: py.id,
          })
        ).ok,
        false,
      );
      assert.deepEqual(app.errors, []);
      return {
        textTypes: Object.keys(outputs),
        rawCsv: true,
        markdownSource: true,
        boundedPreview: true,
        safeMarkup: true,
        ownershipAndPathChecks: true,
      };
    } finally {
      await app.stop();
      await fixture.close();
    }
  },
};
