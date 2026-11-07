import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { modelFixture } from '../../../scripts/test/model-fixture.mjs';
import { rpc, configure, submit, settled, selectModel } from '../../support/desktop.mjs';

export const cases = {
  async 'models.settings'({ dir }) {
    const root = resolve(dir, 'p6-settings'),
      fixture = await modelFixture();
    let app;
    const firstKey = 'synthetic-p6-key-first-DO-NOT-PERSIST-PLAINTEXT',
      secondKey = 'synthetic-p6-key-second-DO-NOT-PERSIST-PLAINTEXT';
    try {
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      let page = app.page;
      await configure(page, firstKey);
      await page.getByRole('button', { name: '设置', exact: true }).click();
      const initial = await rpc(page, { type: 'models.settings' }),
        flash = initial.models.find(
          (m) => m.provider === 'deepseek' && m.model === 'deepseek-flash',
        );
      assert.equal(flash.name, 'DeepSeek-V41-Flash');
      assert.equal(flash.verified, true);
      assert.deepEqual(
        await page
          .getByLabel('思考级别', { exact: true })
          .locator('option')
          .evaluateAll((nodes) => nodes.map((n) => n.value)),
        flash.thinkingLevels,
      );
      assert(!flash.thinkingLevels.includes('minimal'));
      await page.getByLabel('思考级别', { exact: true }).selectOption('off');
      await until(
        async () => (await rpc(page, { type: 'models.settings' })).thinkingLevel === 'off',
        'thinking saved',
      );
      const unsupported = await page.evaluate(() =>
        window.dataAgent.request({ type: 'models.thinking', level: 'minimal' }),
      );
      assert.equal(unsupported.ok, false);
      await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
      fixture.set({ text: 'First model run.' });
      const sessionId = await submit(page, 'First model request.');
      const first = await settled(page, sessionId);
      assert.equal(first.requests[0].model, 'deepseek-flash');
      assert.equal(first.requests[0].thinkingEnabled, false);
      assert.equal(fixture.authorizations.at(-1), `Bearer ${firstKey}`);
      await page.getByRole('button', { name: '设置', exact: true }).click();
      const alternate = initial.models.find(
        (m) => m.provider === 'deepseek' && m.model !== 'deepseek-flash',
      );
      assert(alternate);
      await selectModel(page, alternate.model);
      await until(
        async () =>
          (await rpc(page, { type: 'models.settings' })).selected.model === alternate.model,
        'model changed',
      );
      await page.getByRole('button', { name: '更换 Key', exact: true }).click();
      await page.getByRole('textbox', { name: 'API key', exact: true }).fill(secondKey);
      await page.getByRole('button', { name: '保存凭证', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'API key 已保存' }).waitFor();
      await page.getByLabel('思考级别', { exact: true }).selectOption('high');
      await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
      await app.stop();
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      page = app.page;
      const restored = await rpc(page, { type: 'models.settings' });
      assert.equal(restored.selected.model, alternate.model);
      assert.equal(restored.thinkingLevel, 'high');
      assert(restored.configuredProviders.includes('deepseek'));
      assert(!JSON.stringify(restored).includes(secondKey));
      fixture.set({ text: 'Second model run.' });
      await page.getByRole('textbox', { name: '分析需求' }).fill('Use the changed model.');
      await page.getByRole('button', { name: '发送分析需求', exact: true }).click();
      const second = await until(async () => {
        const s = await rpc(page, { type: 'runtime.snapshot', sessionId });
        return s?.runId !== first.runId && s?.state === 'completed' ? s : null;
      }, 'second model run');
      assert.equal(second.requests[0].model, alternate.model);
      assert.equal(second.requests[0].thinkingEnabled, true);
      assert.equal(fixture.authorizations.at(-1), `Bearer ${secondKey}`);
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByRole('button', { name: '移除凭证', exact: true }).click();
      await page.getByRole('button', { name: '确认移除凭证', exact: true }).click();
      await page.getByRole('status').filter({ hasText: '已移除凭证' }).waitFor();
      assert.equal(await page.getByLabel('选择模型').count(), 0);
      await page.getByLabel('连接提供方', { exact: true }).selectOption('openrouter');
      await page.getByLabel('API key', { exact: true }).fill('synthetic-openrouter');
      await page.getByRole('button', { name: '保存凭证', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'API key 已保存' }).waitFor();
      const basic = (await rpc(page, { type: 'models.settings' })).models.find((m) => !m.reasoning);
      assert(basic);
      await selectModel(page, basic.model);
      await until(
        async () => (await rpc(page, { type: 'models.settings' })).selected.model === basic.model,
        'nonreasoning model selected',
      );
      assert.equal(await page.getByLabel('思考级别', { exact: true }).count(), 0);
      await page.getByTestId('model-verification').filter({ hasText: '未验证兼容性' }).waitFor();
      await app.stop();
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      page = app.page;
      const cleared = await rpc(page, { type: 'models.settings' });
      assert(!cleared.configuredProviders.includes('deepseek'));
      assert.equal(cleared.selected.model, basic.model);
      assert.equal(cleared.thinkingLevel, 'off');
      for (const path of [
        join(root, 'data/state.sqlite'),
        join(root, 'data/state.sqlite-wal'),
        join(root, 'data/sessions', `${sessionId}.jsonl`),
        join(root, 'electron.log'),
      ])
        if (existsSync(path))
          for (const key of [firstKey, secondKey]) {
            const bytes = readFileSync(path);
            assert(!bytes.includes(key));
            assert(!bytes.includes(Buffer.from(key).toString('base64')));
          }
      assert.deepEqual(app.errors, []);
      return {
        byokSaveRotateClearRestart: true,
        persistedPlaintextKeys: false,
        selectedModelUsedOnNextRun: true,
        supportedThinkingLevelsOnly: true,
        thinkingChoiceSentAndPersisted: true,
        compatibilityLabels: true,
      };
    } finally {
      await app?.stop();
      await fixture.close();
    }
  },
};
