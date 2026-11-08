import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { createStoredSession, rpc } from '../../support/desktop.mjs';

export const cases = {
  async 'sessions.selection-recovery'({ dir }) {
    const root = join(dir, 'selection-recovery');
    let app = await startApp(root);
    try {
      assert.equal(await app.page.getByRole('alert').count(), 0);
      await app.page.getByRole('textbox', { name: '分析需求' }).fill('保留的首页草稿');
      const session = await createStoredSession(app.page);
      await app.page.getByRole('textbox', { name: '分析需求' }).fill('旧会话草稿');
      assert.equal(
        await app.page.evaluate(() => localStorage.getItem('selected-session')),
        session.id,
      );
      // Archived sessions are valid even when absent from the default sidebar list.
      await rpc(app.page, { type: 'sessions.archive', sessionId: session.id, archived: true });
      await app.stop();
      app = await startApp(root);
      await until(
        async () =>
          (await app.page.getByTestId('session-title').getAttribute('data-session-id')) ===
          session.id,
        'existing archived selection restored',
      );
      assert.equal(await app.page.getByRole('alert').count(), 0);
      assert.equal(
        await app.page.getByRole('textbox', { name: '分析需求' }).inputValue(),
        '旧会话草稿',
      );
      await app.stop();
      // Simulate deleting ~/.data_agent while Electron's userData survives.
      rmSync(join(root, 'data'), { recursive: true });
      app = await startApp(root);
      assert.deepEqual(await rpc(app.page, { type: 'sessions.list' }), []);
      await until(
        async () =>
          (await app.page.evaluate(() => localStorage.getItem('selected-session'))) === null ||
          (await app.page.getByRole('alert').filter({ hasText: '会话不存在' }).count()) > 0,
        'cached selection reconciled with reset data',
      );
      await app.page.screenshot({ path: join(dir, 'reset-data-startup.png') });
      assert.equal(
        await app.page.getByRole('alert').count(),
        0,
        'reset data must open the home draft without a 会话不存在 error',
      );
      assert.equal(
        await app.page.evaluate(() => localStorage.getItem('selected-session')),
        null,
        'missing session must not remain selected',
      );
      assert.equal(await app.page.getByTestId('session-title').textContent(), '新会话');
      assert.equal(
        await app.page.getByRole('textbox', { name: '分析需求' }).inputValue(),
        '保留的首页草稿',
      );
      for (const theme of ['light', 'dark']) {
        const toggle = app.page.getByRole('button', {
          name: theme === 'light' ? '切换到浅色模式' : '切换到深色模式',
        });
        if (await toggle.count()) await toggle.click();
        for (const [width, height] of [
          [1000, 700],
          [1280, 800],
          [1600, 1000],
        ]) {
          await app.page.setViewportSize({ width, height });
          const input = app.page.getByRole('textbox', { name: '分析需求' });
          await input.focus();
          assert(await input.evaluate((element) => element === document.activeElement));
          assert.equal(await app.page.getByRole('alert').count(), 0);
          await app.page.screenshot({ path: join(dir, `reset-${theme}-${width}.png`) });
        }
      }
      await app.page.getByRole('textbox', { name: '分析需求' }).fill('新的首页草稿');
      assert.deepEqual(await rpc(app.page, { type: 'sessions.list' }), []);
      assert.deepEqual(app.errors, []);
      await app.stop();
      app = await startApp(root);
      assert.equal(await app.page.getByRole('alert').count(), 0);
      assert.equal(await app.page.evaluate(() => localStorage.getItem('selected-session')), null);
      assert.equal(
        await app.page.getByRole('textbox', { name: '分析需求' }).inputValue(),
        '新的首页草稿',
      );
      return {
        existingArchivedSelectionRestored: true,
        staleSelectionCleared: true,
        homeDraftPreservedWithoutCreatingSession: true,
        restartAfterRecovery: true,
      };
    } finally {
      await app.stop();
    }
  },
};
