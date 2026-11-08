import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startApp } from '../../../scripts/test/harness.mjs';
import { liveKey } from '../../../scripts/test/live-key.mjs';
import { waitReviewedRun } from '../../../scripts/eval/run-scenario.mjs';
import { configure, rpc, selectSession } from '../../support/desktop.mjs';

export const cases = {
  async 'examples.live-continuation'({ dir }) {
    let app;
    const key = liveKey();
    try {
      app = await startApp(join(dir, 'live-examples'), { examples: true });
      const examples = await rpc(app.page, { type: 'examples.status' });
      assert.equal(examples.sessions.length, 2, examples.error);
      await configure(app.page, key);
      const records = [];
      for (const example of examples.sessions) {
        await selectSession(app.page, example.id);
        const before = (await rpc(app.page, { type: 'sessions.open', sessionId: example.id }))
          .session;
        const native = readFileSync(before.sessionFile);
        const previous = await rpc(app.page, { type: 'runtime.snapshot', sessionId: example.id });
        const root = join(dir, example.id);
        mkdirSync(root);
        const evidence = {
          id: example.id,
          provider: 'deepseek',
          model: 'deepseek-flash',
          status: 'running',
        };
        await app.page
          .getByRole('textbox', { name: '分析需求' })
          .fill(
            '请继续基于本机工作区 data/netflix_titles.csv 分析。用内置 Python 统计本快照中 2016–2020 年上架电影的作品数和时长中位数（正确处理 rating 中的分钟值），把结果和简短口径说明写为新文件 continuation.md，保留对应 continuation.py。不修改已有报告或原始 CSV，不安装依赖。',
          );
        await app.page.getByRole('button', { name: '发送分析需求', exact: true }).click();
        const final = await waitReviewedRun(app.page, example.id, root, evidence, previous?.runId);
        writeFileSync(
          join(root, 'live-evidence.json'),
          JSON.stringify({ ...evidence, final }, null, 2),
        );
        assert.equal(final.state, 'completed', final.error);
        for (const name of ['continuation.md', 'continuation.py'])
          assert(existsSync(join(before.workspace, name)), name);
        const continued = readFileSync(before.sessionFile);
        assert.deepEqual(continued.subarray(0, native.length), native);
        assert(!continued.toString().includes(key));
        records.push({ id: example.id, runId: final.runId, continued: true });
        await app.stop();
        app = await startApp(join(dir, 'live-examples'), { examples: true });
      }
      return { realProvider: true, records };
    } finally {
      await app?.stop();
    }
  },
};
