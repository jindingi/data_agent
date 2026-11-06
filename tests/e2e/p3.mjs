import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startApp, until } from '../../scripts/test/harness.mjs';
import { verifyRuntime } from '../../scripts/build/verify-runtime.mjs';
import { liveKey } from '../../scripts/test/live-key.mjs';
import { modelFixture } from '../../scripts/test/model-fixture.mjs';

export async function rpc(page, command) { const result = await page.evaluate(command => window.dataAgent.request(command), command); assert.equal(result.ok, true, JSON.stringify(result)); return result.value; }
async function snapshot(page, sessionId) { return rpc(page, { type: 'runtime.snapshot', sessionId }); }
export async function configure(page, key = 'synthetic-p3-fixture-key') {
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('选择模型').selectOption(JSON.stringify({ provider: 'deepseek', model: 'deepseek-flash' }));
  await page.getByRole('textbox', { name: 'API key' }).fill(key);
  await page.getByRole('button', { name: '保存凭证', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'API key 已保存' }).waitFor();
  await page.getByRole('button', { name: '关闭设置' }).click();
}
export async function submit(page, text = 'Execute the requested fixture action.') {
  const known = new Set((await rpc(page, { type: 'sessions.list' })).map(session => session.id));
  await page.getByRole('button', { name: '新会话', exact: true }).click();
  const sessionId = await until(async () => { const id = await page.getByTestId('session-title').getAttribute('data-session-id'); return id && !known.has(id) ? id : null; }, 'new session selected');
  await page.getByRole('textbox', { name: '分析需求' }).fill(text);
  await page.getByRole('button', { name: '发送分析需求', exact: true }).click();
  return sessionId;
}
async function interaction(page, sessionId, kind = 'approval') {
  await page.getByRole('region', { name: kind === 'approval' ? '安全审批' : '澄清问题', exact: true }).waitFor({ timeout: 30_000 });
  return until(async () => (await snapshot(page, sessionId))?.interactions?.find(value => value.kind === kind), 'interaction in authoritative snapshot');
}
export async function settled(page, sessionId) { return until(async () => { const value = await snapshot(page, sessionId); return value && ['completed','failed','cancelled','interrupted'].includes(value.state) ? value : null; }, 'run settled', 60_000); }
async function late(page, value, changes = {}) {
  const response = await page.evaluate(command => window.dataAgent.request(command), { type: 'interaction.answer', interactionId: value.id, sessionId: value.sessionId, runId: value.runId, hostEpoch: value.hostEpoch, digest: value.digest, answer: { kind: value.kind, ...(value.kind === 'approval' ? { decision: 'allow_once' } : { answer: 'late' }) }, ...changes });
  assert.equal(response.ok, false); assert.equal(response.error.code, 'INTERACTION_EXPIRED');
}
export const cases = {
  async 'P3-LIVE-TOOLS'({ dir }) {
    const key = liveKey(), root = resolve(dir, 'p3-live-tools'), nonce = randomUUID();
    let app;
    try {
      app = await startApp(root); await configure(app.page, key);
      const sessionId = await submit(app.page, `这是工作台工具集成验证。请实际调用 write 创建一个 Python 脚本，然后调用 bash 用内置 python3 执行，最后调用 read 读取生成的 report.md。脚本只在当前工作区创建 report.md 与 chart.png，不访问网络、不安装依赖、不读敏感路径。使用 pandas 和 matplotlib，图表标题用中文。report.md 非空并包含标记 ${nonce}。脚本还应打印 JSON 诊断：python=sys.executable、pandas=pandas.__version__、credentialInherited=any('API_KEY' in k for k in os.environ)，只输出布尔值，不输出任何环境变量值。文件路径请用字面量字符串；报告业务内容任意，不评价分析正确性。完成后说明文件路径。`);
      const final = await until(async () => {
        const value = await snapshot(app.page, sessionId);
        if (value?.interactions?.length) throw new Error('Live fixture unexpectedly requires interaction; inspect local evidence before approving.');
        return value && ['completed','failed','cancelled','interrupted'].includes(value.state) ? value : null;
      }, 'actual DeepSeek write/bash/read complete', 240_000);
      assert.equal(final.state, 'completed', final.error ?? 'live task failed');
      for (const name of ['write','bash','read']) assert(final.tools.some(tool => tool.name === name && tool.status === 'completed'), `Missing successful ${name}`);
      const workspace = final.outputDirectory ?? join(root, 'data/workspace', sessionId), report = readFileSync(join(workspace, 'report.md'), 'utf8');
      assert(report.length > 0 && report.includes(nonce)); assert(statSync(join(workspace, 'chart.png')).size > 100);
      assert(final.tools.some(tool => tool.name === 'read' && tool.output.includes(nonce)));
      const bash = final.tools.filter(tool => tool.name === 'bash').map(tool => tool.output).join('\n');
      assert(bash.includes('runtime/darwin-arm64/python/bin/python3')); assert(/"credentialInherited"\s*:\s*false/.test(bash));
      assert(!JSON.stringify(final).includes(key)); assert(!readFileSync(join(root, 'data/sessions', `${sessionId}.jsonl`), 'utf8').includes(key));
      assert(final.requests.length >= 3 && final.requests.every(request => request.model === 'deepseek-flash'));
      assert.deepEqual(app.errors, []); await app.page.screenshot({ path: join(root, 'live-tools.png'), fullPage: true });
      const evidence = { provider: 'deepseek', model: 'deepseek-flash', toolCalls: final.tools.map(tool => ({ name: tool.name, status: tool.status })), requests: final.requests, usage: final.usage, reportNonempty: true, chartNonempty: true, workerNoKey: true, analysisAccuracyJudged: false };
      writeFileSync(join(root, 'live-evidence.json'), JSON.stringify(evidence, null, 2)); return evidence;
    } catch (error) { throw new Error(String(error.stack ?? error).replaceAll(key, '[REDACTED]')); }
    finally { await app?.stop(); }
  },
  async 'P3-RUNTIME'({ dir }) {
    const evidence = [];
    for (const packaged of [false, true]) {
      const root = resolve(dir, packaged ? 'p3-runtime-app' : 'p3-runtime-dev');
      const runtimeRoot = packaged ? resolve('release/mac-arm64/Data Agent.app/Contents/Resources/runtime') : resolve('runtime/darwin-arm64');
      const inventory = verifyRuntime(runtimeRoot), fixture = await modelFixture();
      const app = await startApp(root, { packaged, testModelBaseUrl: fixture.baseUrl });
      try {
        await configure(app.page);
        const source = String.raw`import json,sys,os,importlib.metadata
from pathlib import Path
import pandas,numpy,matplotlib.pyplot as plt,seaborn
plt.plot([1,2],[4,3]); plt.title('地区销售变化'); plt.savefig('中文图表.png'); plt.close()
Path('report.md').write_text('# Runtime delivery\n',encoding='utf-8')
print(json.dumps({'python':sys.executable,'libraries':{n:importlib.metadata.version(n) for n in ['pandas','numpy','matplotlib','seaborn','psutil','pillow','jsonschema']},'credentialInherited':any('API_KEY' in k or k=='P3_SECRET_SENTINEL' for k in os.environ)}))
`;
        fixture.set({ tool: { name: 'write', args: { path: 'runtime_probe.py', content: source } } }, { tool: { name: 'bash', args: { command: 'python3 runtime_probe.py && rg --version && fd --version' } } }, { tool: { name: 'read', args: { path: 'report.md' } } }, { text: 'Runtime checked.' });
        const sessionId = await submit(app.page), final = await settled(app.page, sessionId);
        assert.equal(final.state, 'completed'); assert.equal(final.tools.length, 3); assert(final.tools.every(tool => tool.status === 'completed'), JSON.stringify(final.tools));
        const output = final.tools.find(tool => tool.name === 'bash').output;
        const result = JSON.parse(output.split('\n').find(line => line.startsWith('{')));
        assert.equal(result.credentialInherited, false); assert.equal(result.python, join(runtimeRoot, 'python/bin/python3'));
        assert.deepEqual(result.libraries, inventory.libraries); assert(!/Glyph .* missing/.test(output)); assert(output.includes('ripgrep 15.2.0') && output.includes('fd 10.5.1'));
        assert(statSync(join(final.outputDirectory ?? join(root, 'data/workspace', sessionId), '中文图表.png')).size > 100);
        assert(final.tools.find(tool => tool.name === 'read').output.includes('# Runtime delivery'));
        assert.deepEqual(app.errors, []); evidence.push({ packaged, inventory, python: result.python, chinesePng: true, toolEnvironmentNoKey: true });
      } finally { await app.stop(); await fixture.close(); }
    }
    return evidence;
  },
  async 'P3-APPROVAL'({ dir }) {
    const root = resolve(dir, 'p3-approval'); mkdirSync(root, { recursive: true }); const fixture = await modelFixture(); let app;
    try {
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl }); let page = app.page; await configure(page);
      const operation = (target) => ({ tool: { name: 'bash', args: { command: `printf approved >> ${JSON.stringify(target)}` } } });
      const allowed = join(root, 'allowed.txt'); fixture.set(operation(allowed), { text: 'Approved once.' });
      let sessionId = await submit(page), pending = await interaction(page, sessionId);
      assert(!existsSync(allowed)); await late(page, pending, { digest: '0'.repeat(64) }); await late(page, pending, { runId: randomUUID() });
      await page.getByRole('button', { name: '允许这一次', exact: true }).click();
      assert.equal((await settled(page, sessionId)).state, 'completed'); assert.equal(readFileSync(allowed, 'utf8'), 'approved');
      await late(page, pending); assert.equal(readFileSync(allowed, 'utf8'), 'approved');
      for (const action of ['deny', 'cancel', 'host_exit', 'close_reopen']) {
        const target = join(root, `${action}.txt`); fixture.set(operation(target), { text: 'Operation handled.' });
        sessionId = await submit(page); pending = await interaction(page, sessionId); assert(!existsSync(target));
        if (action === 'deny') await page.getByRole('button', { name: '拒绝', exact: true }).click();
        if (action === 'cancel') await page.getByRole('button', { name: '停止', exact: true }).click();
        if (action === 'host_exit') process.kill(await rpc(page, { type: 'automation.control', action: 'host_pid', sessionId }), 'SIGKILL');
        if (action === 'close_reopen') {
          const old = page; await rpc(page, { type: 'automation.control', action: 'close_reopen' });
          await until(() => old.isClosed(), 'native window actually closed');
          page = await until(() => app.browser.contexts()[0].pages().find(value => value !== old && !value.isClosed()), 'native activate reopened window');
          app.page = page; await page.getByRole('textbox', { name: '分析需求' }).waitFor();
          const restored = await interaction(page, sessionId); assert.equal(restored.id, pending.id); assert(!existsSync(target));
          await page.getByRole('button', { name: '允许这一次', exact: true }).click();
        }
        const final = await settled(page, sessionId);
        if (action === 'host_exit') assert.equal(final.state, 'interrupted');
        if (action === 'cancel') assert.equal(final.state, 'cancelled');
        await late(page, pending);
        assert.equal(existsSync(target), action === 'close_reopen');
        if (action === 'close_reopen') assert.equal(readFileSync(target, 'utf8'), 'approved');
      }
      const deleteTarget = join(root, 'keep.txt'); writeFileSync(deleteTarget, 'keep');
      fixture.set({ tool: { name: 'bash', args: { command: `rm ${JSON.stringify(deleteTarget)}` } } }, { text: 'Deletion declined.' });
      sessionId = await submit(page); await interaction(page, sessionId);
      await page.getByRole('button', { name: '拒绝', exact: true }).click(); await settled(page, sessionId); assert.equal(readFileSync(deleteTarget, 'utf8'), 'keep');
      // A file modified while waiting cannot reuse approval for its old content.
      const changedTarget = join(root, 'changed-target.txt'), script = join(root, 'change.py');
      writeFileSync(script, `from pathlib import Path\nPath(${JSON.stringify(changedTarget)}).write_text('before')\n`);
      fixture.set({ tool: { name: 'bash', args: { command: `python3 ${JSON.stringify(script)}` } } }, { text: 'Changed script rejected.' });
      sessionId = await submit(page); pending = await interaction(page, sessionId);
      writeFileSync(script, readFileSync(script, 'utf8').replace('before', 'after'));
      await page.getByRole('button', { name: '允许这一次', exact: true }).click();
      const changed = await settled(page, sessionId); assert(changed.tools.some(tool => tool.output.includes('已变化'))); assert(!existsSync(changedTarget));
      const quitTarget = join(root, 'quit.txt'); fixture.set(operation(quitTarget), { text: 'Must not run.' });
      sessionId = await submit(page); await interaction(page, sessionId);
      await page.screenshot({ path: join(root, 'approval.png'), fullPage: true });
      await rpc(page, { type: 'automation.control', action: 'quit' }); await app.exit; await app.stop(); app = undefined;
      assert(!existsSync(quitTarget));
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl }); page = app.page;
      assert.equal(await page.getByRole('region', { name: '安全审批' }).count(), 0); assert(!existsSync(quitTarget));
      assert.deepEqual(app.errors, []);
      return { allowOnce: true, deniedNoWrite: true, cancellation: true, hostExit: true, windowCloseReopen: true, quit: true, staleBindingRejected: true, scriptHashRechecked: true, actualHttpRequests: fixture.requests.length };
    } finally { await app?.stop(); await fixture.close(); }
  },
  async 'P3-QUESTION'({ dir }) {
    const fixture = await modelFixture(); const app = await startApp(join(dir, 'p3-question'), { testModelBaseUrl: fixture.baseUrl });
    try {
      const page = app.page; await configure(page);
      for (const mode of ['answer','refuse','cancel']) {
        fixture.set({ tool: { name: 'ask_clarification', args: { question: '按哪种口径统计？', options: ['含税金额','不含税金额'] } } }, { text: 'Clarification received.' });
        const sessionId = await submit(page), pending = await interaction(page, sessionId, 'clarification');
        assert.equal(await page.getByRole('button', { name: '允许这一次' }).count(), 0);
        await late(page, pending, { answer: { kind: 'approval', decision: 'allow_once' } });
        if (mode === 'answer') { await page.getByRole('button', { name: '不含税金额', exact: true }).click(); await page.getByRole('button', { name: '提交回答', exact: true }).click(); }
        if (mode === 'refuse') await page.getByRole('button', { name: '暂不回答', exact: true }).click();
        if (mode === 'cancel') await page.getByRole('button', { name: '停止', exact: true }).click();
        const final = await settled(page, sessionId); await late(page, pending);
        if (mode === 'answer') assert(fixture.requests.at(-1).messages.some(message => message.role === 'tool' && message.content.includes('不含税金额') && message.content.includes('clarification')));
        if (mode === 'refuse') assert(final.tools.some(tool => tool.output.includes('"answer":null')));
        if (mode === 'cancel') assert.equal(final.state, 'cancelled');
      }
      assert.deepEqual(app.errors, []); return { structuredAnswerInProviderRequest: true, refusal: true, cancel: true, cannotGrantApproval: true };
    } finally { await app.stop(); await fixture.close(); }
  },
};
