import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { startApp, until, freePort } from '../../scripts/test/harness.mjs';
import { modelFixture } from '../../scripts/test/model-fixture.mjs';
import { configure, rpc, settled, submit } from './p3.mjs';
import { runFollowup } from '../../scripts/eval/run-followup.mjs';
import { verifyRelease } from '../../scripts/build/verify-release.mjs';

const taskTool = (name, args) => ({ tool: { name, args } });
async function listing(page, sessionId) {
  return until(async () => { const v = await rpc(page, { type: 'artifacts.list', sessionId }); return v.versions.length && v.versions.every(v => v.state === 'published') ? v : null; }, 'all versions published');
}
async function deliver(page, sessionId, previousRunId) {
  const final = await until(async () => { const v = await rpc(page, { type: 'runtime.snapshot', sessionId }); return v?.runId !== previousRunId && ['completed', 'failed', 'cancelled'].includes(v?.state) ? v : null; }, 'delivery terminal', 60000);
  assert.equal(final.state, 'completed', final.error ?? '');
  const files = (await listing(page, sessionId)).files.filter(f => f.runId === final.runId);
  assert(files.some(f => f.relativePath === 'report.md' && f.state === 'ready' && f.size > 0));
  assert(files.some(f => f.kind === 'png' && f.state === 'ready' && f.size > 0));
  await page.getByRole('tab', { name: '报告', exact: true }).click();
  await until(() => page.locator('.artifact-markdown img').evaluateAll(images => images.length > 0 && images.every(i => i.complete && i.naturalWidth > 0)), 'report PNG decoded');
  return final;
}
function tree(root) {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n').map(s => s.trim().split(/\s+/).map(Number));
  const ids = new Set([root]); let changed = true;
  while (changed) { changed = false; for (const [id, parent] of rows) if (ids.has(parent) && !ids.has(id)) { ids.add(id); changed = true; } }
  return [...ids];
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function story(dir, offline) {
  const root = resolve(dir, offline ? 'p7-offline' : 'p7-cdp'), source = join(root, '输入 数据.csv'); mkdirSync(root, { recursive: true });
  const original = 'region,sales\n北区,10\n南区,20\n'; writeFileSync(source, original);
  const fixture = await modelFixture(); let app; const options = { packaged: true, offline, minimalEnvironment: true, pickFiles: [source], testModelBaseUrl: fixture.baseUrl };
  const allPids = new Set(); const track = () => tree(app.child.pid).forEach(pid => allPids.add(pid));
  try {
    app = await startApp(join(root, 'app'), options); let page = app.page; await configure(page);
    await page.getByRole('button', { name: '添加 CSV 文件', exact: true }).click();
    const id = await until(() => page.getByTestId('session-title').getAttribute('data-session-id'), 'input session');
    await page.getByRole('button', { name: '移除文件 输入 数据.csv', exact: true }).waitFor();
    const script = `from pathlib import Path\nimport sys,json,pandas as pd,matplotlib.pyplot as plt\nd=pd.read_csv(${JSON.stringify(source)})\nplt.bar(d.region,d.sales);plt.title('地区销售');plt.savefig('chart.png');plt.close()\nPath('report.md').write_text('# Packaged delivery\\n\\n![地区销售](chart.png)\\n',encoding='utf-8')\nprint(json.dumps({'python':sys.executable}))\n`;
    fixture.set(taskTool('write', { path: 'analysis.py', content: script }), taskTool('bash', { command: 'python3 analysis.py' }), { text: 'Packaged task delivered.' });
    await page.getByRole('textbox', { name: '分析需求' }).fill('生成 report.md 与中文图表'); await page.getByRole('button', { name: '发送分析需求', exact: true }).click();
    const first = await deliver(page, id); track(); const old = readFileSync(join(first.outputDirectory, 'report.md'));
    assert(first.tools.some(t => t.output.includes('/Contents/Resources/runtime/python/bin/python3')));
    assert(fixture.requests[0].messages.some(m => m.role === 'system' && m.content.includes('剩余最多20次')));
    assert(fixture.requests[2].messages.some(m => m.role === 'system' && m.content.includes('剩余最多18次')));
    fixture.set(taskTool('write', { path: 'analysis.py', content: script.replace('Packaged delivery', 'Packaged followup') }), taskTool('bash', { command: 'python3 analysis.py' }), { text: 'New report delivered.' });
    await page.getByRole('textbox', { name: '分析需求' }).fill('继续，生成新版报告和图表。'); await page.getByRole('button', { name: '发送分析需求', exact: true }).click();
    const second = await deliver(page, id, first.runId); assert.notEqual(first.outputDirectory, second.outputDirectory); assert.deepEqual(readFileSync(join(first.outputDirectory, 'report.md')), old);
    track(); assert.deepEqual(app.errors, []); await app.stop();
    app = await startApp(join(root, 'app'), options); page = app.page;
    const restored = await rpc(page, { type: 'runtime.snapshot', sessionId: id }); assert.equal(restored.runId, second.runId); assert(restored.messages.some(m => m.blocks.some(b => b.text?.includes('Packaged task delivered'))));
    const outside = join(root, 'must-not-write.txt'); fixture.set(taskTool('write', { path: outside, content: 'must not execute' }), { text: 'Denied operation handled.' });
    await page.getByRole('textbox', { name: '分析需求' }).fill('Exercise explicit denial.'); await page.getByRole('button', { name: '发送分析需求', exact: true }).click();
    await page.getByRole('region', { name: '安全审批', exact: true }).waitFor(); assert(!existsSync(outside)); await page.getByRole('button', { name: '拒绝', exact: true }).click(); await settled(page, id); assert(!existsSync(outside));
    fixture.set(taskTool('bash', { command: 'while [ ! -f release ]; do printf tick >> heartbeat.txt; sleep 0.1; done' }), { text: 'Should be cancelled.' });
    await page.getByRole('textbox', { name: '分析需求' }).fill('Exercise stop.'); await page.getByRole('button', { name: '发送分析需求', exact: true }).click();
    const working = await until(async () => { const v = await rpc(page, { type: 'runtime.snapshot', sessionId: id }); return v?.state === 'running' && v.outputDirectory && existsSync(join(v.outputDirectory, 'heartbeat.txt')) ? v : null; }, 'actual worker heartbeat');
    track(); const hostPid = await rpc(page, { type: 'automation.control', action: 'host_pid', sessionId: id });
    await page.getByRole('button', { name: '停止', exact: true }).click(); assert.equal((await settled(page, id)).state, 'cancelled'); await until(() => !alive(hostPid), 'cancelled Host exit');
    const bytes = statSync(join(working.outputDirectory, 'heartbeat.txt')).size; await delay(1000); assert.equal(statSync(join(working.outputDirectory, 'heartbeat.txt')).size, bytes);
    if (offline) {
      const probe = `import socket,sys,subprocess,json\ns=socket.socket();s.settimeout(1);parent=s.connect_ex(('192.0.2.1',443));s.close()\nchild=subprocess.check_output([sys.executable,'-I','-B','-c',"import socket; s=socket.socket();s.settimeout(1);print(s.connect_ex(('192.0.2.1',443)))"],text=True)\nprint(json.dumps({'parentErrno':parent,'childErrno':int(child)}))\n`;
      fixture.set(taskTool('write', { path: 'network_probe.py', content: probe }), taskTool('bash', { command: 'python3 network_probe.py' }), { text: 'Network denial observed.' });
      await page.getByRole('textbox', { name: '分析需求' }).fill('Verify test-only OS network denial.'); await page.getByRole('button', { name: '发送分析需求', exact: true }).click();
      await page.getByRole('region', { name: '安全审批', exact: true }).waitFor();
      const pending = await rpc(page, { type: 'runtime.snapshot', sessionId: id }); assert(pending.interactions[0].description.includes('network_probe.py'));
      // Exactly this fixed, reviewed fixture probes a reserved documentation IP; never approve arbitrary model code.
      await page.getByRole('button', { name: '允许这一次', exact: true }).click(); const final = await settled(page, id);
      const bash = final.tools.findLast(t => t.name === 'bash' && JSON.parse(t.arguments).command === 'python3 network_probe.py'); assert(bash, 'network probe tool result present'); assert.equal(bash.status, 'completed', bash.output);
      const observed = JSON.parse(bash.output.split('\n').find(line => line.startsWith('{'))); assert.deepEqual(observed, { parentErrno: 1, childErrno: 1 });
    }
    assert.equal(readFileSync(source, 'utf8'), original); assert.deepEqual(app.errors, []); track();
    await page.screenshot({ path: join(root, 'final.png') });
    await app.stop(); app = undefined; await until(() => [...allPids].every(pid => !alive(pid)), 'zero tracked app/Host/tool residuals', 10000);
    const result = { packaged: true, offline, minimalPath: '/usr/bin:/bin', reportAndPngDisplayed: true, nativeHistoryRestart: true, oldVersionPreserved: true, denialNoWrite: true, actualWorkerStopped: true, sourceUnchanged: true, networkBlockedInWorkerAndDescendant: offline, requests: fixture.requests.length, trackedPids: [...allPids], residuals: 0 };
    writeFileSync(join(root, 'evidence.json'), JSON.stringify(result, null, 2)); return result;
  } finally { await app?.stop(); await fixture.close(); }
}

export const cases = {
  async 'P7-THEME-INPUT'({ dir }) {
    const root = resolve(dir, 'p7-theme-input'); mkdirSync(root, { recursive: true });
    const fixture = await modelFixture();
    const options = { packaged: true, testModelBaseUrl: fixture.baseUrl };
    let app;
    try {
      app = await startApp(join(root, 'app'), options); let page = app.page;
      const theme = () => page.locator('html').getAttribute('data-theme');
      assert.equal(await theme(), 'dark');
      const darkBackground = await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor);
      await page.screenshot({ path: join(root, 'dark-welcome.png') });
      await page.getByRole('button', { name: '切换到浅色模式', exact: true }).click();
      assert.equal(await theme(), 'light');
      assert.notEqual(await page.locator('body').evaluate(el => getComputedStyle(el).backgroundColor), darkBackground);
      await delay(250); // Let the existing button/card color transitions settle before visual review.
      await page.screenshot({ path: join(root, 'light-welcome.png') });
      await page.reload(); assert.equal(await theme(), 'light');
      await configure(page);
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.screenshot({ path: join(root, 'light-settings.png') });
      await page.getByRole('button', { name: '关闭设置', exact: true }).click();

      const input = page.getByRole('textbox', { name: '分析需求' });
      await input.fill('   '); await input.press('Enter');
      await input.fill('第一行'); await input.press('Shift+Enter'); await input.press('Space');
      assert.equal(await input.inputValue(), '第一行\n ');
      // Synthetic composition events exercise renderer guards; submission itself uses real CDP keyboard input.
      await input.evaluate(el => {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, keyCode: 229 }));
        el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, repeat: true }));
      });
      await delay(200); assert.equal(fixture.requests.length, 0);
      assert.equal(await input.inputValue(), '第一行\n ');
      const markdown = '# 主题预览\n\n中文 **正文** 与 [文件](report.md)。\n\n|地区|金额|\n|---|---|\n|北区|10|\n\n```python\nprint("hello")\n```\n';
      fixture.set(taskTool('write', { path: 'report.md', content: markdown }), { text: markdown });
      await input.fill('第一行'); await input.press('Shift+Enter'); await input.press('Space'); await input.press('a');
      const expected = '第一行\n a'; assert.equal(await input.inputValue(), expected);
      await input.press('Enter');
      const id = await until(() => page.getByTestId('session-title').getAttribute('data-session-id'), 'keyboard-created session');
      const first = await settled(page, id); assert.equal(first.state, 'completed');
      assert.equal(fixture.requests.length, 2); assert.equal(await input.inputValue(), '');
      assert(fixture.requests[0].messages.some(m => m.role === 'user' && (typeof m.content === 'string' ? m.content : m.content.map(b => b.text ?? '').join('\n')).includes(expected)));
      await listing(page, id); await page.getByRole('tab', { name: '报告', exact: true }).click();
      await page.locator('.artifact-markdown').getByRole('heading', { name: '主题预览' }).waitFor();
      await page.locator('.tool-card summary').first().click();
      await page.screenshot({ path: join(root, 'light-report.png') });
      await page.getByRole('button', { name: '切换到深色模式', exact: true }).click();
      await delay(250);
      await page.screenshot({ path: join(root, 'dark-report.png') });
      await page.getByRole('button', { name: '切换到浅色模式', exact: true }).click();
      assert.deepEqual(app.errors, []); await app.stop();

      app = await startApp(join(root, 'app'), options); page = app.page;
      assert.equal(await theme(), 'light');
      fixture.set({ text: 'Compatibility shortcut delivered.' });
      const restoredInput = page.getByRole('textbox', { name: '分析需求' });
      await restoredInput.fill('兼容原有快捷键'); await restoredInput.press('Meta+Enter');
      const second = await until(async () => { const v = await rpc(page, { type: 'runtime.snapshot', sessionId: id }); return v?.runId !== first.runId && v?.state === 'completed' ? v : null; }, 'compatibility shortcut completed');
      assert.notEqual(second.runId, first.runId); assert.equal(fixture.requests.length, 3);
      await page.getByRole('button', { name: '切换到深色模式', exact: true }).click();
      await page.reload(); assert.equal(await theme(), 'dark');
      assert.deepEqual(app.errors, []);
      return { packaged: true, lightAndDark: true, themeReloadAndRestart: true, enterSends: true, shiftEnterNewline: true, spacePreserved: true, imeAndRepeatDoNotSend: true, blankDoesNotSend: true, metaEnterCompatible: true, requests: fixture.requests.length };
    } finally { await app?.stop(); await fixture.close(); }
  },
  'P7-CDP': ({ dir }) => story(dir, false),
  'P7-OFFLINE': ({ dir }) => story(dir, true),
  'P7-LIVE': ({ dir }) => runFollowup(join(dir, 'p7-live'), { packaged: true }),
  async 'P7-PACKAGE'({ dir }) {
    const inventory = verifyRelease();
    const relocated = join(resolve(dir), 'relocated', 'Data Agent.app'); mkdirSync(join(resolve(dir), 'relocated'), { recursive: true });
    execFileSync('/usr/bin/ditto', [resolve('release/mac-arm64/Data Agent.app'), relocated]);
    const fixture = await modelFixture(), app = await startApp(join(dir, 'p7-relocated'), { packaged: true, packagedPath: relocated, minimalEnvironment: true, testModelBaseUrl: fixture.baseUrl });
    try {
      await configure(app.page); const code = 'import sys,json,pandas,numpy,seaborn,matplotlib.pyplot as plt\nplt.plot([1,2]);plt.title("中文图表");plt.savefig("chart.png");print(json.dumps({"python":sys.executable}))';
      fixture.set(taskTool('write', { path: 'probe.py', content: code }), taskTool('bash', { command: 'python3 probe.py && rg --version && fd --version' }), { text: 'Relocated runtime finished.' });
      const id = await submit(app.page), final = await settled(app.page, id); assert.equal(final.state, 'completed');
      const tool = final.tools.find(t => t.name === 'bash'); assert.equal(tool.status, 'completed', tool.output); assert(tool.output.includes(relocated)); assert(!tool.output.includes('Glyph '));
      const info = await rpc(app.page, { type: 'system.info' }); assert.equal(info.packaged, true); assert.equal(info.architecture, 'arm64'); assert.equal(info.abi, '150');
      assert.deepEqual(app.errors, []); return { inventory, relocatedRuntime: true, info };
    } finally { await app.stop(); await fixture.close(); }
  },
  async 'P7-DEFAULTS'({ dir }) {
    const root = resolve(dir, 'p7-defaults'), fixture = await modelFixture(), port = await freePort();
    const app = await startApp(root, { packaged: true, automation: false, port, minimalEnvironment: true, testModelBaseUrl: fixture.baseUrl });
    try {
      let endpoint = false; try { await fetch(`http://127.0.0.1:${port}/json/version`); endpoint = true; } catch {}
      assert.equal(endpoint, false); assert(!existsSync(join(root, 'data/automation.json'))); assert.equal(fixture.requests.length, 0);
      const sqlite = execFileSync(resolve('runtime/darwin-arm64/python/bin/python3'), ['-I','-B','-c', 'import sqlite3,sys,json; c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True);print(json.dumps(c.execute("select key from app_metadata where key like \'credential.%\'").fetchall()))', join(root,'data/state.sqlite')], { encoding: 'utf8' });
      assert.deepEqual(JSON.parse(sqlite), []);
      const second = spawn(resolve('release/mac-arm64/Data Agent.app/Contents/MacOS/Data Agent'), [], { env: { HOME: process.env.HOME, PATH: '/usr/bin:/bin', DATA_AGENT_HOME: join(root,'data'), DATA_AGENT_USER_DATA: join(root,'userData') }, stdio: ['ignore','pipe','pipe'] });
      let output = ''; second.stdout.on('data', b => { output += b; }); second.stderr.on('data', b => { output += b; });
      const exit = new Promise(resolve => second.once('exit', resolve));
      try { await until(() => second.exitCode !== null, 'second instance exit', 15000); } finally { if (second.exitCode === null) second.kill('SIGKILL'); await exit; }
      assert.equal(second.exitCode, 0); assert(output.includes('already running')); assert(alive(app.child.pid));
      return { productionDebugClosed: true, noAutomaticModelRequest: true, noCredentialStored: true, secondInstanceRejected: true };
    } finally { await app.stop(); await fixture.close(); }
  },
  async 'P7-USABILITY'({ dir }) {
    const root = resolve(dir, 'p7-usability'); mkdirSync(root, { recursive: true }); const source = join(root,'拖拽 数据.csv'); const bytes = Buffer.from([255,0,34,10]); writeFileSync(source, bytes);
    const fixture = await modelFixture(), app = await startApp(join(root,'app'), { testModelBaseUrl: fixture.baseUrl });
    let oldClipboard;
    try {
      const page = app.page; await configure(page);
      // A real disk-backed File enters the actual drop handler; no business IPC is called by the driver.
      await page.evaluate(() => { const input = document.createElement('input'); input.type='file'; input.id='cdp-disk-file'; input.hidden=true; document.body.append(input); });
      const cdp = await app.browser.contexts()[0].newCDPSession(page);
      const document = await cdp.send('DOM.getDocument');
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: document.root.nodeId, selector: '#cdp-disk-file' });
      await cdp.send('DOM.setFileInputFiles', { nodeId, files: [source] });
      await cdp.detach();
      await page.evaluate(() => { const file = document.querySelector('#cdp-disk-file').files[0], data = new DataTransfer(); data.items.add(file); document.querySelector('.main-area').dispatchEvent(new DragEvent('drop',{bubbles:true,dataTransfer:data})); document.querySelector('#cdp-disk-file').remove(); });
      await page.getByRole('button', { name:'移除文件 拖拽 数据.csv', exact:true }).waitFor();
      const id = await page.getByTestId('session-title').getAttribute('data-session-id'); const detail = await rpc(page,{type:'sessions.open',sessionId:id}); assert.equal(detail.files[0].path,source); assert.equal(detail.files[0].size,bytes.length);
      await page.getByLabel('输入区思考级别').selectOption('off'); await until(async()=>(await rpc(page,{type:'models.settings'})).thinkingLevel==='off','composer thinking persisted');
      const markdown = '# Copyable report\n\n中文 Markdown **原文**。\n';
      fixture.set(taskTool('write',{path:'report.md',content:markdown}),{text:'Report delivered.'});
      await page.getByRole('textbox',{name:'分析需求'}).fill('Generate report.md'); await page.getByRole('button',{name:'发送分析需求',exact:true}).click(); await settled(page,id); await listing(page,id);
      await page.getByRole('tab',{name:'报告',exact:true}).click(); await page.getByRole('heading',{name:'Copyable report'}).waitFor();
      oldClipboard=execFileSync('/usr/bin/pbpaste');
      await page.getByRole('button',{name:'复制 Markdown',exact:true}).click(); await page.getByRole('status').filter({hasText:'已复制 Markdown'}).waitFor(); assert.equal(execFileSync('/usr/bin/pbpaste',{encoding:'utf8'}),markdown);
      await page.setViewportSize({width:940,height:650}); const before=await page.locator('.main-area').boundingBox();
      await page.getByRole('button',{name:'展开结果面板',exact:true}).click(); const report=await page.getByRole('complementary',{name:'结果面板'}).boundingBox(), after=await page.locator('.main-area').boundingBox(); assert.equal(before.width,after.width); assert(report.width>700); assert(report.x>=0&&report.x+report.width<=941);
      await page.screenshot({path:join(root,'expanded-report.png')}); await page.getByRole('button',{name:'关闭结果面板',exact:true}).click();
      const send=await page.getByRole('button',{name:'发送分析需求',exact:true}).boundingBox(); assert(send.x>=0&&send.x+send.width<=940);
      assert.deepEqual(readFileSync(source),bytes); assert.deepEqual(app.errors,[]);
      return { diskFileDropThroughPreload:true,noCsvParsing:true,markdownClipboardExact:true,composerThinking:true,narrowReportOverlay:true };
    } finally { if(oldClipboard!==undefined)execFileSync('/usr/bin/pbcopy',[],{input:oldClipboard});await app.stop();await fixture.close(); }
  },
};
