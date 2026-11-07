import { createStoredSession } from '../../support/desktop.mjs';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { startApp, until } from '../../../scripts/test/harness.mjs';

async function list(page, archived = false) {
  const result = await page.evaluate(
    (archived) => window.dataAgent.request({ type: 'sessions.list', archived }),
    archived,
  );
  assert.equal(result.ok, true);
  return result.value;
}

const newSession = createStoredSession;

async function rename(page, title) {
  await page.getByRole('button', { name: '会话操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '重命名会话', exact: true }).click();
  await page.getByRole('textbox', { name: '会话标题' }).fill(title);
  await page.getByRole('button', { name: '保存名称', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: `打开会话 ${title}`, exact: true }).waitFor();
}
export const cases = {
  async 'sessions.metadata'({ dir }) {
    const custom = join(dir, '自选 父目录');
    mkdirSync(custom, { recursive: true });
    const app = await startApp(join(dir, 'metadata'), { pickDirectory: custom });
    try {
      const a = await newSession(app.page);
      await rename(app.page, '销售趋势');
      const b = await createStoredSession(app.page, true);
      assert.equal(b.workspace, join(custom, b.id));
      assert.notEqual(a.workspace, b.workspace);
      await rename(app.page, '客户分析');
      await app.page.getByRole('textbox', { name: '搜索会话' }).fill('销售');
      await app.page
        .getByRole('button', { name: '打开会话 客户分析' })
        .waitFor({ state: 'hidden' });
      await app.page.getByRole('button', { name: '打开会话 销售趋势' }).click();
      await app.page.getByRole('button', { name: '会话操作', exact: true }).click();
      await app.page.getByRole('menuitem', { name: '归档会话', exact: true }).click();
      await until(async () => (await list(app.page, true)).length === 1, 'archive persisted');
      await app.page.getByRole('button', { name: '查看归档会话' }).click();
      await app.page.getByRole('button', { name: '打开会话 销售趋势' }).click();
      await app.page.getByRole('button', { name: '会话操作', exact: true }).click();
      await app.page.getByRole('menuitem', { name: '恢复会话', exact: true }).click();
      await until(async () => (await list(app.page, true)).length === 0, 'unarchive persisted');
      assert.equal((await list(app.page)).length, 2);
      assert.deepEqual(app.errors, []);
      return { renameSearchArchiveRestore: true, customParentPreserved: true };
    } finally {
      await app.stop();
    }
  },
};
