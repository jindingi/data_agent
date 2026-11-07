import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { liveKey } from '../../../scripts/test/live-key.mjs';
import { waitReviewedRun } from '../../../scripts/eval/run-scenario.mjs';
import { configure, openWorkspaceFile, rpc } from '../../support/desktop.mjs';
import { openOfflineReport } from '../../support/offline-report.mjs';

const csv =
  'month,region,amount\n2026-01,east,10\n2026-01,west,40\n2026-02,east,20\n2026-02,west,50\n2026-03,east,30\n2026-03,west,60\n';
const intents = [
  [
    'narrative',
    '写一篇趋势解释为主的叙事报告，单个折线图即可，不需要指标卡或表格。按月份筛选，scope 选项值为 all 和 2026-02。',
    '2026-02',
    70,
  ],
  [
    'comparison',
    '比较两个地区的金额分布，选择适合少量观测值的图形，避免把三个样本当成可靠总体。不需要仪表盘。按地区筛选，scope 选项值为 all、east、west。',
    'east',
    60,
  ],
  [
    'linked',
    '做地区与月份的多维比较，至少两个不同图形随地区筛选同步更新。布局自由，不强制表格。scope 选项值为 all、east、west。',
    'east',
    60,
  ],
];
export const cases = {
  async 'reports.live-interactive'({ dir }) {
    const key = liveKey();
    const results = [];
    for (const [id, intent, selection, total] of intents) {
      const root = join(dir, `live-html-${id}`);
      mkdirSync(root, { recursive: true });
      const source = join(root, 'sales.csv');
      writeFileSync(source, csv);
      const app = await startApp(join(root, 'application'), { pickFiles: [source] });
      const evidence = { id, model: 'deepseek-flash', judgeStatus: 'not_reviewed', intent };
      try {
        await configure(app.page, key);
        await app.page.getByRole('button', { name: '添加 CSV 文件', exact: true }).click();
        await app.page.getByRole('button', { name: '移除文件 sales.csv', exact: true }).waitFor();
        // These are user-requested acceptance affordances, not a production report schema.
        await app.page
          .getByRole('textbox', { name: '分析需求' })
          .fill(
            `${intent} 交付可离线打开的交互式 report.html，使用内置 interactive-report skill。为本次验收，使用 id=scope 的原生 select 作为主筛选器，初值 all；id=total 的元素只显示当前范围 amount 合计的数字。这是本次报告要求，不是通用布局模板。报告说明口径与样本限制，只交付 HTML，不另外生成 Markdown。`,
          );
        await app.page.getByRole('button', { name: '发送分析需求', exact: true }).click();
        const sessionId = await until(
          () => app.page.getByTestId('session-title').getAttribute('data-session-id'),
          'live session',
        );
        const final = await waitReviewedRun(app.page, sessionId, root, evidence);
        evidence.final = final;
        assert.equal(final.state, 'completed', final.error ?? 'live generation failed');
        const file = join(final.outputDirectory, 'report.html');
        const bytes = readFileSync(file);
        assert(bytes.length > 1_000_000 && bytes.length <= 32 * 1024 * 1024);
        const binding = (await rpc(app.page, { type: 'sessions.agentConfig', sessionId })).binding;
        assert(binding.skills.some((s) => s.id === 'interactive-report'));
        await openWorkspaceFile(app.page, 'report.html');
        const report = await until(
          () =>
            app.browser
              .contexts()
              .flatMap((c) => c.pages())
              .find((p) => p.url().startsWith('data-report:')),
          'live report view',
        );
        await report.locator('#scope').waitFor();
        await until(
          () => report.evaluate(() => innerWidth > 100 && innerHeight > 100),
          'native report layout',
        );
        assert.equal(Number(await report.locator('#total').textContent()), 210);
        assert((await report.locator('canvas,svg').count()) > 0);
        const before = await report.screenshot();
        await report.locator('#scope').selectOption(selection);
        await until(
          async () => Number(await report.locator('#total').textContent()) === total,
          'filtered live total',
        );
        assert(!before.equals(await report.screenshot()));
        await report.screenshot({ path: join(root, 'filtered.png'), fullPage: true });
        await report.locator('#scope').selectOption('all');
        assert.equal(Number(await report.locator('#total').textContent()), 210);
        const copy = join(root, 'exported.html');
        writeFileSync(copy, bytes);
        const external = await openOfflineReport(join(root, 'offline'), copy);
        try {
          await external.page.locator('#scope').selectOption(selection);
          assert.equal(Number(await external.page.locator('#total').textContent()), total);
        } finally {
          await external.close();
        }
        assert.equal(readFileSync(source, 'utf8'), csv);
        assert.deepEqual(app.errors, []);
        evidence.status = 'passed';
        evidence.bytes = bytes.length;
        evidence.sessionFile = join(root, 'application/data/sessions', `${sessionId}.jsonl`);
        evidence.report = file;
        evidence.programChecks = {
          preview: true,
          filtering: true,
          offline: true,
          accuracyJudge: false,
        };
      } catch (error) {
        evidence.status = 'failed';
        evidence.error = String(error.stack ?? error).replaceAll(key, '[REDACTED]');
      } finally {
        await app.stop();
        writeFileSync(join(root, 'evaluation.json'), JSON.stringify(evidence, null, 2));
      }
      results.push(evidence);
    }
    assert(
      results.every((r) => r.status === 'passed'),
      results
        .filter((r) => r.status !== 'passed')
        .map((r) => `${r.id}: ${r.error}`)
        .join('\n'),
    );
    return {
      reports: results.map(({ id, bytes, programChecks }) => ({ id, bytes, programChecks })),
      judgeStatus: 'not_reviewed',
    };
  },
};
