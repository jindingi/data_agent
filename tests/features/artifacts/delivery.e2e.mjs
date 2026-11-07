import { openPreview } from '../../support/desktop.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, statSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { modelFixture } from '../../../scripts/test/model-fixture.mjs';
import { configure, rpc, settled } from '../../support/desktop.mjs';

export const cases = {
  async 'artifacts.delivery'({ dir }) {
    const root = resolve(dir, 'p4-delivery'),
      exported = join(root, 'exported');
    mkdirSync(exported, { recursive: true });
    const sourceA = join(root, 'sales.csv'),
      sourceB = join(root, 'regions.csv');
    writeFileSync(sourceA, 'region,amount\nN,10\nS,20\n');
    writeFileSync(sourceB, 'region,label\nN,North\nS,South\n');
    const original = [sourceA, sourceB].map((path) => readFileSync(path));
    const fixture = await modelFixture(),
      app = await startApp(root, {
        testModelBaseUrl: fixture.baseUrl,
        pickFiles: [sourceA, sourceB],
        exportDirectory: exported,
      });
    try {
      const page = app.page;
      await configure(page);
      await page.getByRole('button', { name: '添加 CSV 文件', exact: true }).click();

      await page.getByRole('button', { name: '移除文件 regions.csv', exact: true }).waitFor();
      const script = String.raw`from pathlib import Path
import pandas as pd
import matplotlib.pyplot as plt
left = pd.read_csv(${JSON.stringify(sourceA)})
right = pd.read_csv(${JSON.stringify(sourceB)})
combined = left.merge(right,on='region')
Path('figures').mkdir(exist_ok=True)
plt.bar(combined['label'], combined['amount']); plt.title('地区销售'); plt.savefig('figures/chart.png'); plt.close()
Path('report.md').write_text('# Delivery report\n\nThis content is not a business correctness assertion.\n\n![地区销售](figures/chart.png)\n',encoding='utf-8')
`;
      fixture.set(
        { tool: { name: 'read', args: { path: sourceA } } },
        { tool: { name: 'read', args: { path: sourceB } } },
        { tool: { name: 'write', args: { path: 'analysis.py', content: script } } },
        { tool: { name: 'bash', args: { command: 'python3 analysis.py' } } },
        { text: 'Report and chart delivered.' },
      );
      await page
        .getByRole('textbox', { name: '分析需求' })
        .fill('分析两份文件并生成 report.md 与图表。');
      await page.getByRole('button', { name: '发送分析需求', exact: true }).click();
      const sessionId = await until(
        () => page.getByTestId('session-title').getAttribute('data-session-id'),
        'session created for imported paths',
      );
      const final = await settled(page, sessionId);
      assert.equal(final.state, 'completed', final.error ?? '');
      const listing = await until(async () => {
        const value = await rpc(page, { type: 'artifacts.list', sessionId });
        return value.files.length === 3 ? value : null;
      }, 'three generated artifacts registered');
      assert(listing.files.every((file) => file.state === 'ready'));
      assert(listing.files.every((file) => file.path.startsWith(final.outputDirectory + '/')));
      assert(final.outputDirectory.endsWith(`/workspace/${sessionId}`));
      assert.equal(readFileSync(join(final.outputDirectory, 'report.md'), 'utf8').length > 0, true);
      assert(
        fixture.requests[0].messages.some(
          (message) =>
            message.role === 'system' &&
            message.content.includes('data-analysis') &&
            message.content.includes('SKILL.md'),
        ),
      );
      assert(
        !fixture.requests[0].messages.some((message) => String(message.content).includes('N,10')),
      );
      await openPreview(page, '预览');
      await page.getByRole('heading', { name: 'Delivery report', exact: true }).waitFor();
      const image = page.getByRole('img', { name: '地区销售', exact: true });
      await until(
        () => image.evaluate((element) => element.complete && element.naturalWidth > 0),
        'real PNG decoded in report preview',
      );
      assert.equal(await page.locator('[data-run-state="completed"]').innerText(), '执行完成');
      await page.getByRole('button', { name: '导出文件', exact: true }).click();
      await page.getByRole('status').filter({ hasText: '已导出：' }).waitFor();
      const exportRoot = join(exported, readdirSync(exported)[0]);
      assert.equal(
        readFileSync(join(exportRoot, 'report.md'), 'utf8'),
        readFileSync(join(final.outputDirectory, 'report.md'), 'utf8'),
      );
      assert(statSync(join(exportRoot, 'figures/chart.png')).size > 100);
      assert(!existsSync(join(exportRoot, 'sales.csv')));
      for (let i = 0; i < 2; i++)
        assert.deepEqual(readFileSync([sourceA, sourceB][i]), original[i]);
      // The same Markdown and image IDs must display newly written image bytes.
      const originalImage = await image.getAttribute('src');
      const firstChart = listing.files.find((file) => file.kind === 'png');
      fixture.set(
        {
          tool: {
            name: 'write',
            args: {
              path: 'analysis.py',
              content: script
                .replace("combined['amount']", "combined['amount'] * 2")
                .replace("plt.title('地区销售')", "plt.title('更新后的地区销售')"),
            },
          },
        },
        { tool: { name: 'bash', args: { command: 'python3 analysis.py' } } },
        { text: 'Updated chart in the shared workspace.' },
      );
      await page.getByRole('textbox', { name: '分析需求' }).fill('只更新图表，保留报告正文。');
      await page.getByRole('button', { name: '发送分析需求', exact: true }).click();
      await until(async () => {
        const value = await rpc(page, { type: 'runtime.snapshot', sessionId });
        return value?.runId !== final.runId && value?.state === 'completed';
      }, 'chart update completed');
      await until(async () => {
        const next = await rpc(page, { type: 'artifacts.list', sessionId });
        return next.files.some(
          (file) => file.id === firstChart.id && file.sha256 !== firstChart.sha256,
        );
      }, 'same image ID re-registered with new hash');
      await until(
        async () =>
          (await image.getAttribute('src')) !== originalImage &&
          (await image.evaluate((node) => node.complete && node.naturalWidth > 0)),
        'updated PNG displayed inside unchanged Markdown',
      );
      await page.screenshot({ path: join(root, 'report-chart.png'), fullPage: true });
      assert.deepEqual(app.errors, []);
      const evidence = {
        version: listing.versions[0].id,
        files: listing.files.map((file) => ({ path: file.relativePath, sha256: file.sha256 })),
        reportRendered: true,
        imageDecoded: true,
        exportRelativeImageAvailable: true,
        sourcesUnchanged: true,
      };
      writeFileSync(join(root, 'delivery-evidence.json'), JSON.stringify(evidence, null, 2));
      return evidence;
    } finally {
      await app.stop();
      await fixture.close();
    }
  },
};
