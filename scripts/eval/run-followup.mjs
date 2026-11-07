import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { runScenario, waitReviewedRun } from './run-scenario.mjs';
import { startApp, until } from '../test/harness.mjs';
import { liveKey } from '../test/live-key.mjs';
import { rpc } from '../../tests/e2e/p3.mjs';

export async function runFollowup(root, { packaged = false } = {}) {
  root = resolve(root);
  mkdirSync(root, { recursive: true });
  const key = liveKey();
  let app;
  const task =
    '继续刚才的分析，但本次只比较 2026-07 到 2026-08，按销售额下降比例优先排名，说明与上一轮首末月比较的区别。给出各地区金额和比例变化，不推断业务原因。生成本轮新的 report.md 和一张中文 PNG，报告使用相对图片链接，保留之前的报告，不修改原 CSV。';
  const evidence = {
    id: 'J5-FOLLOWUP',
    task,
    status: 'running',
    judgeStatus: 'not_reviewed',
    startedAt: new Date().toISOString(),
    model: 'deepseek-flash',
    packaged,
  };
  writeFileSync(join(root, 'evaluation.json'), JSON.stringify(evidence, null, 2));
  try {
    const initial = await runScenario('J1-SALES', join(root, 'initial'), { packaged });
    const first = JSON.parse(readFileSync(initial.evidence, 'utf8'));
    Object.assign(evidence, {
      initialEvidence: initial.evidence,
      sessionId: first.sessionId,
      sessionFile: first.sessionFile,
      inputPaths: first.inputPaths,
      sourceTreeHash: first.sourceTreeHash,
      commit: first.commit,
      skillHash: first.skillHash,
      initialRunId: first.final.runId,
    });
    const old = first.artifacts.find((f) => f.relativePath === 'report.md'),
      oldHash = createHash('sha256').update(readFileSync(old.path)).digest('hex');
    const inputHashes = new Map(
      first.inputPaths.map((path) => [
        path,
        createHash('sha256').update(readFileSync(path)).digest('hex'),
      ]),
    );
    const before = readFileSync(first.sessionFile, 'utf8').trim().split('\n').map(JSON.parse),
      oldIds = before.map((row) => row.id);
    app = await startApp(join(root, 'initial/application'), { packaged });
    const page = app.page;
    await page.getByRole('button', { name: '打开会话 新会话', exact: true }).click();
    const recovered = await rpc(page, { type: 'runtime.snapshot', sessionId: first.sessionId });
    assert.equal(recovered.state, 'completed');
    assert.equal(recovered.runId, first.final.runId);
    await page.getByRole('textbox', { name: '分析需求' }).fill(task);
    await page.getByRole('button', { name: '发送分析需求', exact: true }).click();
    const final = await waitReviewedRun(page, first.sessionId, root, evidence, first.final.runId);
    evidence.final = final;
    assert.equal(final.state, 'completed', final.error ?? 'Followup failed');
    assert.notEqual(final.runId, first.final.runId);
    assert.notEqual(final.outputDirectory, first.final.outputDirectory);
    const listing = await until(async () => {
      const x = await rpc(page, { type: 'artifacts.list', sessionId: first.sessionId });
      return x.versions.some((v) => v.runId === final.runId && v.state === 'published') ? x : null;
    }, 'new report registered');
    const files = listing.files.filter((f) => f.runId === final.runId),
      report = files.find(
        (f) => f.relativePath === 'report.md' && f.size > 0 && f.state === 'ready',
      ),
      chart = files.find((f) => f.kind === 'png' && f.state === 'ready' && f.size > 0);
    evidence.artifacts = files;
    assert(report);
    assert(chart);
    assert.equal(createHash('sha256').update(readFileSync(old.path)).digest('hex'), oldHash);
    const after = readFileSync(first.sessionFile, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(
      after.slice(0, before.length).map((row) => row.id),
      oldIds,
    );
    assert.equal(new Set(after.map((row) => row.id)).size, after.length);
    assert.equal(
      after.filter((row) => row.type === 'message' && row.message.role === 'user').length,
      2,
    );
    assert(final.requests.length > 0 && final.requests.every((r) => r.model === 'deepseek-flash'));
    assert(final.requests[0].userMessages >= 2);
    assert(final.requests[0].toolResultHashes.length > 0);
    await page.getByRole('tab', { name: '报告', exact: true }).click();
    await page.getByLabel('选择报告或图表').selectOption(report.id);
    await page.locator('.artifact-markdown').waitFor();
    await page.screenshot({ path: join(root, 'followup-report.png'), fullPage: true });
    await page.getByLabel('选择报告或图表').selectOption(chart.id);
    await until(
      () =>
        page
          .locator('.artifact-scroll > .artifact-image')
          .evaluate((i) => i.complete && i.naturalWidth > 0),
      'followup chart shown',
    );
    for (const [path, hash] of inputHashes)
      assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), hash);
    assert(!JSON.stringify(final).includes(key));
    assert(!readFileSync(first.sessionFile, 'utf8').includes(key));
    assert.deepEqual(app.errors, []);
    evidence.status = 'passed';
    evidence.programChecks = {
      restartedActualApp: true,
      nativeHistoryInProviderRequest: true,
      newReportAndPngNonempty: true,
      oldReportHashPreserved: true,
      historyNotDuplicated: true,
      analysisAccuracyChecked: false,
    };
  } catch (error) {
    evidence.status = 'failed';
    evidence.error = String(error.stack ?? error).replaceAll(key, '[REDACTED]');
  } finally {
    await app?.stop();
    evidence.finishedAt = new Date().toISOString();
    writeFileSync(join(root, 'evaluation.json'), JSON.stringify(evidence, null, 2));
  }
  if (evidence.status !== 'passed') throw new Error(evidence.error);
  return {
    evaluationId: evidence.id,
    evidence: join(root, 'evaluation.json'),
    programChecks: evidence.programChecks,
    judgeStatus: evidence.judgeStatus,
  };
}
