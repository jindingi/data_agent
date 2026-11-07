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
export async function configure(page, key = 'synthetic-p3-fixture-key') {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page
    .getByLabel('选择模型')
    .selectOption(JSON.stringify({ provider: 'deepseek', model: 'deepseek-flash' }));
  await page.getByRole('textbox', { name: 'API key' }).fill(key);
  await page.getByRole('button', { name: '保存凭证', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'API key 已保存' }).waitFor();
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
