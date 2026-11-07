import { createStoredSession } from '../support/desktop.mjs';
import { openPreview } from '../support/desktop.mjs';
import { testBuildDir } from '../../scripts/test/run-context.mjs';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startApp, until, freePort } from '../../scripts/test/harness.mjs';
import { startDevApp } from '../../scripts/test/dev-harness.mjs';

async function info(page) {
  const result = await page.evaluate(() => window.dataAgent.request({ type: 'system.info' }));
  assert.equal(result.ok, true);
  return result.value;
}
export const cases = {
  async 'P0-DEV'({ dir }) {
    const app = await startDevApp(join(dir, 'vite-dev'));
    try {
      const page = app.page;
      const result = await page.evaluate(() => window.dataAgent.request({ type: 'system.info' }));
      assert.equal(result.ok, true, JSON.stringify({ url: page.url(), result }));
      assert.match(page.url(), /^http:\/\/localhost:\d+\/$/);
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByText('应用诊断', { exact: true }).click();
      await page.getByRole('button', { name: '检查连接' }).click();
      await page.getByRole('status').filter({ hasText: '连接正常' }).waitFor();
      await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
      await page.getByRole('button', { name: '新会话', exact: true }).click();
      assert.equal(await page.getByTestId('session-title').getAttribute('data-session-id'), null);
      const { id } = await createStoredSession(page);
      await page.reload();
      await until(
        async () =>
          (await page.getByTestId('session-title').getAttribute('data-session-id')) === id,
        'dev session restored',
      );
      assert.equal(
        (
          await page.evaluate(() =>
            window.dataAgent.request({ type: 'system.ping', text: 'after-reload' }),
          )
        ).ok,
        true,
      );
      assert.equal(await page.getByText('请求来源不受信任', { exact: true }).count(), 0);
      const trustedURL = page.url();
      // CDP navigation bypasses the product's link handler: Main must still reject
      // a different document, even when served by the same development origin.
      await page.goto(`${trustedURL}?untrusted=1`);
      await page.getByRole('textbox', { name: '分析需求' }).waitFor();
      const rejected = await page.evaluate(() => window.dataAgent.request({ type: 'system.info' }));
      assert.equal(rejected.ok, false);
      assert.equal(rejected.error.code, 'UNTRUSTED_SENDER');
      await page.goto(trustedURL);
      await page.getByRole('textbox', { name: '分析需求' }).waitFor();
      assert.equal(
        (await page.evaluate(() => window.dataAgent.request({ type: 'system.info' }))).ok,
        true,
      );
      assert.deepEqual(app.errors, []);
      return {
        realPnpmDev: true,
        url: page.url(),
        nativeIPC: true,
        sessionCreateAndReload: true,
        sameOriginOtherDocumentRejected: true,
      };
    } finally {
      await app.stop();
    }
  },
  async 'P0-CDP'({ dir }) {
    const app = await startApp(join(dir, 'desktop'));
    try {
      const { page } = app;
      const startup = JSON.parse(readFileSync(join(app.root, 'data/automation.json'), 'utf8'));
      assert.equal(startup.background, true);
      assert.equal(startup.windowVisible, false);
      assert.equal(startup.windowFocused, false);
      await page.getByRole('textbox', { name: '分析需求' }).fill('分析地区销售变化');
      assert.equal(
        await page.getByRole('textbox', { name: '分析需求' }).inputValue(),
        '分析地区销售变化',
      );
      await page.getByRole('button', { name: '切换结果面板' }).click();
      await openPreview(page, '预览');
      await page.getByRole('heading', { name: '还没有预览' }).waitFor();
      await page.getByRole('button', { name: '关闭结果面板' }).click();
      await page.getByRole('button', { name: '收起侧栏' }).click();
      assert.equal(await page.getByLabel('会话侧栏').count(), 0);
      await page.getByRole('button', { name: '展开侧栏' }).click();
      await page.getByRole('button', { name: '看清变化', exact: false }).click();
      assert.match(
        await page.getByRole('textbox', { name: '分析需求' }).inputValue(),
        /最近 3 个月/,
      );
      await page.screenshot({ path: join(dir, 'desktop.png') });
      assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
      assert.deepEqual(app.errors, []);
      return { screenshot: 'desktop.png', info: await info(page) };
    } finally {
      await app.stop();
    }
  },
  async 'P0-IPC'({ dir }) {
    const app = await startApp(join(dir, 'ipc'));
    try {
      const { page } = app;
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByText('应用诊断', { exact: true }).click();
      await page.getByRole('button', { name: '检查连接' }).click();
      await page.getByRole('status').filter({ hasText: '连接正常' }).waitFor();
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
      await page.getByRole('button', { name: '检查连接' }).click();
      await page.getByRole('status').filter({ hasText: 'Agent 进程已退出' }).waitFor();
      assert.deepEqual(app.errors, []);
      return { schemaRejections: 3, nativeSQLite: system.sqliteVersion, hostCrashDetected: true };
    } finally {
      await app.stop();
    }
  },
  async 'P0-ISOLATION'({ dir }) {
    const a = await startApp(join(dir, 'instance-a'));
    let b, normal;
    try {
      b = await startApp(join(dir, 'instance-b'));
      const ai = await info(a.page),
        bi = await info(b.page);
      assert.notEqual(ai.dataHome, bi.dataHome);
      for (const instance of [a, b]) {
        const meta = JSON.parse(readFileSync(join(instance.root, 'data/automation.json'), 'utf8'));
        assert.equal(meta.paths.home, join(instance.root, 'data'));
        assert.equal(meta.userData, join(instance.root, 'userData'));
        assert.notEqual(meta.userData, meta.paths.home);
        assert.ok(existsSync(join(meta.paths.home, 'state.sqlite')));
      }
      const normalPort = await freePort();
      normal = await startApp(join(dir, 'normal'), { automation: false, port: normalPort });
      let connected = false;
      try {
        await fetch(`http://127.0.0.1:${normalPort}/json/version`);
        connected = true;
      } catch {
        /* Must not listen. */
      }
      assert.equal(connected, false);
      assert.equal(existsSync(join(normal.root, 'data/automation.json')), false);
      return { twoIsolatedInstances: true, productionDebugClosed: true };
    } finally {
      await a.stop();
      await b?.stop();
      await normal?.stop();
    }
  },
  async 'P0-PACKAGE'({ dir }) {
    assert.ok(existsSync(join(testBuildDir(), 'main/index.js')));
    assert.ok(existsSync(join(testBuildDir(), 'main/agent.js')));
    const app = await startApp(join(dir, 'packaged'), { packaged: true });
    try {
      await app.page.getByRole('button', { name: '设置', exact: true }).click();
      await app.page.getByText('应用诊断', { exact: true }).click();
      await app.page.getByRole('button', { name: '检查连接' }).click();
      await app.page.getByRole('status').filter({ hasText: '连接正常' }).waitFor();
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
