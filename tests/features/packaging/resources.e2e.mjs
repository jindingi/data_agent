import { testBuildDir, runContext } from '../../../scripts/test/run-context.mjs';
import { execFileSync } from 'node:child_process';
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
    const reused = execFileSync(
      'pnpm',
      ['package:dir', '--run-root', runContext().root, '--no-build', '--no-package'],
      { encoding: 'utf8' },
    );
    const context = JSON.parse(reused.split('\n').find((line) => line.startsWith('{')));
    assert.equal(context.root, runContext().root);
    const verified = execFileSync('pnpm', ['verify:release', '--run-root', context.root], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    assert(verified.includes(context.bundlePath));
    assert.ok(existsSync(join(testBuildDir(), 'main/index.js')));
    assert.ok(existsSync(join(testBuildDir(), 'main/agent.js')));
    const app = await startApp(join(dir, 'packaged'), { packaged: true });
    try {
      await app.page.getByRole('button', { name: '设置', exact: true }).click();
      await app.page.getByRole('tab', { name: '本地与诊断', exact: true }).click();
      await app.page.getByText('应用诊断', { exact: true }).click();
      await app.page.getByRole('button', { name: '检查本地引擎' }).click();
      await app.page.getByRole('status').filter({ hasText: '本地引擎正常' }).waitFor();
      const system = await info(app.page);
      assert.equal(system.packaged, true);
      assert.equal(system.architecture, 'arm64');
      assert.ok(system.sqliteVersion);
      await app.page.getByRole('tab', { name: 'Agent 配置', exact: true }).click();
      await app.page.getByRole('textbox', { name: '行为指令', exact: true }).waitFor();
      assert(
        await app.page.getByRole('switch', { name: '启用 data-analysis', exact: true }).isChecked(),
      );
      const config = await app.page.evaluate(() =>
        window.dataAgent.request({ type: 'agentConfig.get' }),
      );
      assert(config.ok);
      assert.equal(config.value.current.revision, 1);
      assert(existsSync(config.value.current.skills[0].filePath));
      await app.page.screenshot({ path: join(dir, 'packaged.png') });
      assert.deepEqual(app.errors, []);
      return { info: system, screenshot: 'packaged.png' };
    } finally {
      await app.stop();
    }
  },
};
