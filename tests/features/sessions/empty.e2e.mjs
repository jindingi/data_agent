import { createStoredSession } from '../../support/desktop.mjs';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { startApp } from '../../../scripts/test/harness.mjs';

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
  async 'sessions.empty'({ dir }) {
    const root = join(dir, 'empty-session');
    let app = await startApp(root);
    try {
      const created = await newSession(app.page);
      assert.ok(existsSync(created.workspace));
      assert.equal(existsSync(created.sessionFile), false);
      assert.equal(created.state, 'draft');
      await rename(app.page, '持久化草稿');
      await app.stop();
      app = await startApp(root);
      await app.page.getByRole('button', { name: '打开会话 持久化草稿' }).waitFor();
      const reopened = (await list(app.page))[0];
      assert.equal(reopened.id, created.id);
      assert.equal(reopened.workspace, created.workspace);
      assert.equal(reopened.sessionFile, created.sessionFile);
      assert.equal(reopened.createdAt, created.createdAt);
      assert.equal(existsSync(created.sessionFile), false);
      assert.deepEqual(app.errors, []);
      return { sessionId: created.id, draftWithoutJSONL: true, metadataPreserved: true };
    } finally {
      await app.stop();
    }
  },
};
