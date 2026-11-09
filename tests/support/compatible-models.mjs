import { rpc, selectModel } from './desktop.mjs';

/** Drive the same provider settings form used by customers, including manual model registration. */
export async function configureCompatible(
  page,
  { provider, baseUrl, key, model, profile = 'basic', reasoning = false, contextWindow = 131072 },
) {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('连接提供方', { exact: true }).selectOption(provider);
  const edit = page.getByRole('button', { name: '更换 Key', exact: true });
  if (await edit.count()) await edit.click();
  await page.getByLabel('API Base URL', { exact: true }).fill(baseUrl);
  await page.getByLabel('API key', { exact: true }).fill(key);
  await page.getByRole('button', { name: '保存凭证', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'API key 已保存' }).waitFor();
  await page.getByLabel('兼容模型 ID', { exact: true }).fill(model);
  await page.getByLabel('兼容模型名称', { exact: true }).fill(model);
  await page.getByLabel('模型上下文窗口', { exact: true }).fill(String(contextWindow));
  await page.getByLabel('服务兼容配置', { exact: true }).selectOption(profile);
  if (reasoning) await page.getByRole('checkbox', { name: '启用可配置思考' }).check();
  await page.getByRole('button', { name: '保存模型配置', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '模型配置已保存' }).waitFor();
  await selectModel(page, model);
  await page.getByRole('button', { name: '关闭对话框' }).click();
  return rpc(page, { type: 'models.settings' });
}
