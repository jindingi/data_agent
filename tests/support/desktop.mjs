import assert from 'node:assert/strict';
import { until } from '../../scripts/test/harness.mjs';

export async function rpc(page, command) {
  const result = await page.evaluate((command) => window.dataAgent.request(command), command);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}
export async function snapshot(page, sessionId) {
  return rpc(page, { type: 'runtime.snapshot', sessionId });
}
export async function selectModel(page, model) {
  await page.getByRole('button', { name: '选择模型', exact: true }).click();
  await page.getByRole('combobox', { name: '搜索模型', exact: true }).fill(model);
  await page
    .getByRole('option')
    .filter({ has: page.getByText(model, { exact: true }) })
    .click();
  await page.locator('.model-picker-popover').waitFor({ state: 'hidden' });
  await until(
    async () => (await rpc(page, { type: 'models.settings' })).selected.model === model,
    'model selected',
  );
}
export async function configure(
  page,
  key = 'synthetic-p3-fixture-key',
  provider = 'deepseek',
  model = 'deepseek-flash',
) {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('连接提供方', { exact: true }).selectOption(provider);
  const edit = page.getByRole('button', { name: '更换 Key', exact: true });
  if (await edit.count()) await edit.click();
  await page.getByRole('textbox', { name: 'API key', exact: true }).fill(key);
  await page.getByRole('button', { name: '保存凭证', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'API key 已保存' }).waitFor();
  await selectModel(page, model);
  await page.getByRole('button', { name: '关闭对话框' }).click();
}
export async function submit(page, text = 'Execute the requested fixture action.') {
  const known = new Set((await rpc(page, { type: 'sessions.list' })).map((session) => session.id));
  await page.getByRole('button', { name: '新会话', exact: true }).click();
  await page.getByRole('textbox', { name: '分析需求' }).fill(text);
  await page.getByRole('button', { name: '发送分析需求', exact: true }).click();
  const sessionId = await until(async () => {
    const id = await page.getByTestId('session-title').getAttribute('data-session-id');
    return id && !known.has(id) ? id : null;
  }, 'first submission accepted');
  return sessionId;
}
export async function settled(page, sessionId) {
  return until(
    async () => {
      const value = await snapshot(page, sessionId);
      return value && ['completed', 'failed', 'cancelled', 'interrupted'].includes(value.state)
        ? value
        : null;
    },
    'run settled',
    60_000,
  );
}

/** Storage fixtures may create an empty legacy session; product UI creates only on accepted send. */
export async function createStoredSession(page, chooseWorkspace = false) {
  const session = await rpc(page, { type: 'sessions.create', chooseWorkspace });
  assert(session);
  await selectSession(page, session.id);
  return session;
}
export async function selectSession(page, id) {
  await page.locator(`.session-list button[data-session-id="${id}"]`).click();
  await until(
    async () => (await page.getByTestId('session-title').getAttribute('data-session-id')) === id,
    'session selected',
  );
}
export async function openPreview(page, tab = '预览') {
  if (!(await page.getByRole('complementary', { name: '结果面板' }).isVisible()))
    await page.getByRole('button', { name: '切换结果面板' }).click();
  await page.getByRole('tab', { name: tab, exact: true }).click();
}
export async function openExecutionProcesses(page) {
  for (const toggle of await page.locator('.process-toggle[aria-expanded="false"]').all())
    await toggle.click();
}
