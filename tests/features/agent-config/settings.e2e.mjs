import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { modelFixture } from '../../../scripts/test/model-fixture.mjs';
import { configure, rpc, submit, settled, selectSession } from '../../support/desktop.mjs';

export const cases = {
  async 'agent-config.settings'({ dir }) {
    const root = join(dir, 'agent-config'),
      fixture = await modelFixture();
    let app;
    try {
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      let page = app.page;
      await configure(page);
      const v1 = (await rpc(page, { type: 'agentConfig.get' })).current;
      fixture.set(
        { tool: { name: 'read', args: { path: v1.skills[0].filePath } } },
        { text: 'Read the bundled instructions.' },
      );
      const oldId = await submit(page, 'Read the bundled skill.');
      assert.equal((await settled(page, oldId)).state, 'completed');
      assert(
        fixture.requests[1].messages.some(
          (m) => m.role === 'tool' && String(m.content).includes('Data analysis in the workbench'),
        ),
      );
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByRole('tab', { name: 'Agent 配置', exact: true }).click();
      const prompt = page.getByRole('textbox', { name: '系统提示词', exact: true });
      const beforePreview = (await rpc(page, { type: 'sessions.list' })).length;
      const requestsBeforePreview = fixture.requests.length;
      await page.getByText('查看完整系统提示词预览', { exact: true }).click();
      const preview = page.locator('pre[aria-label="完整系统提示词预览"]');
      await until(
        async () => (await preview.textContent().catch(() => ''))?.includes('<available_skills>'),
        'SDK preview with skill tags',
      );
      const previewText = await preview.innerText();
      assert(previewText.includes('<skills>'));
      assert(previewText.includes('<location>'));
      assert(previewText.includes('<cwd>\n/〈新会话工作区〉\n</cwd>'));
      await preview.hover();
      await page.mouse.wheel(0, 900);
      await until(
        () => preview.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 2),
        'read SDK preview through cwd',
      );
      await preview.screenshot({ path: join(root, 'sdk-prompt-preview-skills-tail.png') });
      assert.equal((await rpc(page, { type: 'sessions.list' })).length, beforePreview);
      assert.equal(fixture.requests.length, requestsBeforePreview);
      await prompt.fill('Synthetic configuration draft.');
      await until(
        async () =>
          (await preview.textContent().catch(() => ''))?.startsWith(
            'Synthetic configuration draft.',
          ),
        'preview updates from current draft',
      );
      await page.getByRole('tab', { name: '模型与连接', exact: true }).click();
      await page.getByRole('tab', { name: 'Agent 配置', exact: true }).click();
      assert.equal(await prompt.inputValue(), 'Synthetic configuration draft.');
      await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
      const confirm = page.getByRole('dialog', { name: '保存 Agent 配置修改？', exact: true });
      await confirm.waitFor();
      await confirm.getByRole('button', { name: '继续编辑', exact: true }).click();
      assert.equal(await prompt.inputValue(), 'Synthetic configuration draft.');
      await page.getByRole('button', { name: '撤销修改', exact: true }).click();
      assert.equal(await prompt.inputValue(), v1.config.systemPrompt);
      await page.getByRole('switch', { name: '启用 read', exact: true }).uncheck();
      assert(await page.getByRole('button', { name: '保存配置', exact: true }).isDisabled());
      await page.getByRole('button', { name: '启用 read 并保留 Skills', exact: true }).click();
      assert(await page.getByRole('switch', { name: '启用 read', exact: true }).isChecked());
      await prompt.fill('Synthetic concise chat instructions.');
      await page.getByRole('switch', { name: '启用 data-analysis', exact: true }).uncheck();
      for (const id of v1.config.enabledTools)
        await page.getByRole('switch', { name: `启用 ${id}`, exact: true }).uncheck();
      await page.getByText('查看完整系统提示词预览', { exact: true }).click();
      await until(async () => {
        const text = await preview.textContent().catch(() => '');
        return text?.includes('<cwd>') && !text.includes('<skills>');
      }, 'disabled skill disappears from SDK preview');
      await page.screenshot({ path: join(root, 'sdk-prompt-preview.png') });
      await page.getByText('查看完整系统提示词预览', { exact: true }).click();
      for (const [width, height] of [
        [1440, 900],
        [1180, 760],
        [900, 650],
      ]) {
        await page.setViewportSize({ width, height });
        for (const theme of ['light', 'dark']) {
          await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
          const body = page.locator('.settings-body');
          await body.evaluate((el) => (el.scrollTop = 0));
          await page.screenshot({ path: join(root, `config-${width}-${theme}-top.png`) });
          await page
            .getByRole('switch', { name: '启用 data-analysis', exact: true })
            .scrollIntoViewIfNeeded();
          const layout = await page.locator('.settings-dialog').evaluate((el) => ({
            overflow: el.scrollWidth > el.clientWidth,
            scroll: el.querySelector('.settings-body').scrollTop,
            footer: el.querySelector('.config-save-bar').getBoundingClientRect().bottom,
            bottom: el.getBoundingClientRect().bottom,
          }));
          assert.equal(layout.overflow, false);
          assert(layout.scroll > 0);
          assert(layout.footer <= layout.bottom + 1);
          await page.screenshot({ path: join(root, `config-${width}-${theme}-bottom.png`) });
        }
      }
      await page.getByRole('button', { name: '保存配置', exact: true }).click();
      await page.getByRole('status').filter({ hasText: '已保存，将用于新会话' }).waitFor();
      const v2 = (await rpc(page, { type: 'agentConfig.get' })).current;
      assert.equal(v2.revision, 2);
      assert.deepEqual(v2.config.enabledTools, []);
      assert.equal(
        (await rpc(page, { type: 'sessions.agentConfig', sessionId: oldId })).binding.revision,
        1,
      );
      // A stale revision must fail without discarding the user's editor draft.
      await prompt.fill('Unsaved conflict draft');
      await rpc(page, {
        type: 'agentConfig.save',
        expectedRevision: 2,
        config: { ...v2.config, systemPrompt: 'Latest saved configuration' },
      });
      await page.getByRole('button', { name: '保存配置', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: '配置已在其他操作中更新' }).waitFor();
      assert.equal(await prompt.inputValue(), 'Unsaved conflict draft');
      await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
      await confirm.getByRole('button', { name: '放弃修改', exact: true }).click();
      await page.getByRole('button', { name: '会话操作', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Agent 配置', exact: true }).click();
      const details = page.getByRole('dialog', { name: '此会话的 Agent 配置', exact: true });
      await details.getByText('系统提示词', { exact: true }).click();
      assert((await details.innerText()).includes('版本 v1'));
      assert((await details.innerText()).includes('当前默认配置为 v3'));
      assert.equal(
        await details.locator('pre[aria-label="会话系统提示词"]').innerText(),
        fixture.requests[0].messages[0].content,
      );
      const savedPrompt = details.locator('pre[aria-label="会话系统提示词"]');
      await savedPrompt.hover();
      await page.mouse.wheel(0, 1200);
      await until(
        () => savedPrompt.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 2),
        'read stored system prompt through cwd',
      );
      await details.screenshot({ path: join(root, 'session-config.png') });
      const count = (await rpc(page, { type: 'sessions.list' })).length;
      await details.getByRole('button', { name: '使用最新配置新建会话', exact: true }).click();
      assert.equal((await rpc(page, { type: 'sessions.list' })).length, count);
      fixture.set({ text: 'Chat without tools.' });
      const newId = await submit(page, 'Hello, no tools needed.');
      assert.equal((await settled(page, newId)).state, 'completed');
      assert.deepEqual(fixture.requests.at(-1).tools ?? [], []);
      assert(
        JSON.stringify(fixture.requests.at(-1).messages[0]).includes('Latest saved configuration'),
      );
      assert(!JSON.stringify(fixture.requests.at(-1).messages[0]).includes('data-analysis'));
      assert.equal(
        (await rpc(page, { type: 'sessions.agentConfig', sessionId: newId })).binding.revision,
        3,
      );
      const history = join(root, 'data/sessions', `${newId}.jsonl`);
      assert(readFileSync(history, 'utf8').includes('data_agent.agent_config'));
      await app.stop();
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      page = app.page;
      assert.equal((await rpc(page, { type: 'agentConfig.get' })).current.revision, 3);
      fixture.set({ text: 'Same old configuration.' });
      await selectSession(page, oldId);
      const earlier = fixture.requests.length;
      const priorRun = (await rpc(page, { type: 'runtime.snapshot', sessionId: oldId })).runId;
      await page
        .getByRole('textbox', { name: '分析需求' })
        .fill('Continue with the original configuration.');
      await page.getByRole('button', { name: '发送分析需求', exact: true }).click();
      await until(async () => {
        const snapshot = await rpc(page, { type: 'runtime.snapshot', sessionId: oldId });
        return snapshot?.runId !== priorRun && snapshot?.state === 'completed';
      }, 'old session completes with its own configuration');
      await until(() => fixture.requests.length > earlier, 'old session request');
      assert.equal((await settled(page, oldId)).state, 'completed');
      assert.deepEqual(fixture.requests.at(-1).tools, fixture.requests[0].tools);
      assert.deepEqual(
        fixture.requests.at(-1).messages.slice(0, fixture.requests[1].messages.length),
        fixture.requests[1].messages,
      );
      // No accidental output from a pure chat configuration.
      assert(
        !existsSync(
          join(
            (await rpc(page, { type: 'sessions.open', sessionId: newId })).session.workspace,
            'report.md',
          ),
        ),
      );
      return { versions: 3, historicalVersion: 1, sizes: 3, themes: 2, liveRequests: 0 };
    } finally {
      await app?.stop();
      await fixture.close();
    }
  },
};
