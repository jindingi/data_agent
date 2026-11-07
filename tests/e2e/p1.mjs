import { createStoredSession, selectSession, rpc, openPreview } from '../support/desktop.mjs';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { startApp, until } from '../../scripts/test/harness.mjs';

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
  async 'P1-EMPTY'({ dir }) {
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
  async 'P1-METADATA'({ dir }) {
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
  async 'P1-INPUT-REF'({ dir }) {
    const inputDir = join(dir, '原文件');
    mkdirSync(inputDir, { recursive: true });
    const file = join(inputDir, '数据.csv');
    const raw = Buffer.from([0xff, 0x00, 0x22, 0x0a]);
    writeFileSync(file, raw);
    const root = join(dir, 'file-ref');
    let app = await startApp(root, { pickFiles: [file] });
    try {
      const created = await createStoredSession(app.page);
      await rpc(app.page, { type: 'files.pick', sessionId: created.id });
      assert.deepEqual(readFileSync(file), raw);
      assert.deepEqual(readdirSync(created.workspace), []);
      await openPreview(app.page, '文件');
      await app.page.getByText(file, { exact: true }).waitFor();
      await app.stop();
      unlinkSync(file);
      app = await startApp(root);
      await selectSession(app.page, created.id);
      await openPreview(app.page, '文件');
      await app.page.getByText('原文件不可用', { exact: true }).waitFor();
      assert.equal(existsSync(file), false);
      assert.deepEqual(readdirSync(created.workspace), []);
      const detail = await app.page.evaluate(
        (id) => window.dataAgent.request({ type: 'sessions.open', sessionId: id }),
        created.id,
      );
      assert.equal(detail.value.files[0].path, file);
      assert.equal(detail.value.files[0].missing, true);
      return { originalPathOnly: true, noCSVParsing: true, missingFileReported: true };
    } finally {
      await app.stop();
    }
  },
};
