import { testBuildDir } from '../../../scripts/test/run-context.mjs';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startApp } from '../../../scripts/test/harness.mjs';

async function info(page) {
  const result = await page.evaluate(() => window.dataAgent.request({ type: 'system.info' }));
  assert.equal(result.ok, true);
  return result.value;
}
export const cases = {
  async 'packaging.resources'({ dir }) {
    assert.ok(existsSync(join(testBuildDir(), 'main/index.js')));
    assert.ok(existsSync(join(testBuildDir(), 'main/agent.js')));
    const app = await startApp(join(dir, 'packaged'), { packaged: true });
    try {
      await app.page.getByRole('button', { name: '设置', exact: true }).click();
      await app.page.getByText('应用诊断', { exact: true }).click();
      await app.page.getByRole('button', { name: '检查本地引擎' }).click();
      await app.page.getByRole('status').filter({ hasText: '本地引擎正常' }).waitFor();
      const system = await info(app.page);
      assert.equal(system.packaged, true);
      assert.equal(system.architecture, 'arm64');
      assert.ok(system.sqliteVersion);
      await app.page.screenshot({ path: join(dir, 'packaged.png') });
      assert.deepEqual(app.errors, []);
      return { info: system, screenshot: 'packaged.png' };
    } finally {
      await app.stop();
    }
  },
};
