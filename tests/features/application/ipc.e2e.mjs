import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startApp, until } from '../../../scripts/test/harness.mjs';

async function info(page) {
  const result = await page.evaluate(() => window.dataAgent.request({ type: 'system.info' }));
  assert.equal(result.ok, true);
  return result.value;
}
export const cases = {
  async 'application.ipc'({ dir }) {
    const app = await startApp(join(dir, 'ipc'));
    try {
      const { page } = app;
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByRole('tab', { name: '本地与诊断', exact: true }).click();
      await page.getByText('应用诊断', { exact: true }).click();
      await page.getByRole('button', { name: '检查本地引擎' }).click();
      await page.getByRole('status').filter({ hasText: '本地引擎正常' }).waitFor();
      for (const command of [
        { type: 'unknown' },
        { type: 'system.ping', text: 1 },
        { type: 'system.info', shell: 'anything' },
      ]) {
        const invalid = await page.evaluate(
          (command) => window.dataAgent.request(command),
          command,
        );
        assert.equal(invalid.ok, false);
        assert.equal(invalid.error.code, 'INVALID_COMMAND');
      }
      const system = await info(page);
      assert.ok(system.sqliteVersion);
      assert.equal(system.hostStatus, 'ready');
      process.kill(system.hostPid, 'SIGKILL');
      await until(async () => (await info(page)).hostStatus === 'exited', 'Host crash detected');
      await page.getByRole('button', { name: '检查本地引擎' }).click();
      await page.getByRole('status').filter({ hasText: 'Agent 进程已退出' }).waitFor();
      assert.deepEqual(app.errors, []);
      return { schemaRejections: 3, nativeSQLite: system.sqliteVersion, hostCrashDetected: true };
    } finally {
      await app.stop();
    }
  },
};
