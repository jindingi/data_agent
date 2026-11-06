import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, statSync, existsSync, readdirSync, openSync, ftruncateSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runScenario } from '../../scripts/eval/run-scenario.mjs';
import { startApp, until } from '../../scripts/test/harness.mjs';
import { modelFixture } from '../../scripts/test/model-fixture.mjs';
import { configure, rpc, settled, submit, cases as p3 } from './p3.mjs';

const importScenarios = new Map();
async function importScenario(dir) {
  if (importScenarios.has(dir)) return importScenarios.get(dir);
  const task = (async () => {
    const root=resolve(dir,'p4-import');mkdirSync(join(root,'a'),{recursive:true});mkdirSync(join(root,'b'),{recursive:true});
    const files=[join(root,'a/data.csv'),join(root,'b/data.csv')];writeFileSync(files[0],Buffer.from([255,0,34,10]));writeFileSync(files[1],'not a valid table');
    const app=await startApp(join(root,'app'),{pickFiles:files});
    try {
      const page=app.page;await page.getByRole('button',{name:'添加 CSV 文件',exact:true}).click();
      await until(()=>page.getByRole('button',{name:'移除文件 data.csv',exact:true}).count().then(n=>n===2),'two same-name attachments');
      const id=await page.getByTestId('session-title').getAttribute('data-session-id'), detail=await rpc(page,{type:'sessions.open',sessionId:id});
      assert.deepEqual(new Set(detail.files.map(file=>file.path)),new Set(files));assert.deepEqual(detail.files.map(file=>file.size).sort((a,b)=>a-b),[4,17]);
      assert.deepEqual(readdirSync(detail.session.workspace),[]);assert.equal(existsSync(detail.session.sessionFile),false);
      await page.getByRole('button',{name:'切换结果面板',exact:true}).click();for(const path of files)await page.getByText(path,{exact:true}).waitFor();
      await page.locator('.attachment-list > span').filter({has:page.locator(`span[title="${files[0]}"]`)}).count();
      await page.locator(`.attachment-list > span[title="${files[0]}"]`).getByRole('button').click();
      await until(async()=>{const next=await rpc(page,{type:'sessions.open',sessionId:id});return next.files.length===1&&next.files[0].path===files[1];},'remove exact original path');
      assert.deepEqual(readFileSync(files[0]),Buffer.from([255,0,34,10]));assert.equal(readFileSync(files[1],'utf8'),'not a valid table');
    } finally { await app.stop(); }
    for(const mode of ['single','total']) {
      const source=join(root,mode);mkdirSync(source);const paths=(mode==='single'?[100_000_001]:[60_000_000,60_000_000]).map((size,index)=>{const path=join(source,`${index}.csv`),fd=openSync(path,'w');ftruncateSync(fd,size);closeSync(fd);return path;});
      const instance=await startApp(join(root,mode+'-app'),{pickFiles:paths});
      try{await instance.page.getByRole('button',{name:'添加 CSV 文件',exact:true}).click();await instance.page.getByRole('alert').filter({hasText:mode==='single'?'单个 CSV':'CSV 总大小'}).waitFor();const id=await instance.page.getByTestId('session-title').getAttribute('data-session-id');assert.equal((await rpc(instance.page,{type:'sessions.open',sessionId:id})).files.length,0);}finally{await instance.stop();}
    }
    return {sameBasenameDistinctPaths:true,metadataOnlyImport:true,noCopyOrParsing:true,removeByIdentity:true,singleAndAggregate100MBLimits:true};
  })();importScenarios.set(dir,task);return task;
}
export const cases = {
  async 'P4-IMPORT'({dir}) { return importScenario(dir); },
  async 'P4-MULTIFILE'({dir}) { return importScenario(dir); },
  async 'P4-CLARIFY'(context) { return p3['P3-QUESTION'](context); },
  async 'P4-RESULT-STATE'({dir}) {
    const fixture=await modelFixture(),app=await startApp(join(dir,'p4-result-state'),{testModelBaseUrl:fixture.baseUrl});
    try {
      const page=app.page;await configure(page);
      fixture.set({text:'I claim the report is correct, but no files were created.'});let id=await submit(page);assert.equal((await settled(page,id)).state,'completed');
      await page.getByRole('complementary',{name:'结果面板'}).waitFor();await page.getByRole('tab',{name:'报告',exact:true}).click();await page.getByRole('heading',{name:'还没有报告'}).waitFor();
      fixture.set({tool:{name:'write',args:{path:'report.md',content:''}}},{tool:{name:'write',args:{path:'chart.png',content:'broken png'}}},{text:'Finished.'});id=await submit(page);await settled(page,id);
      const listing=await until(async()=>{const value=await rpc(page,{type:'artifacts.list',sessionId:id});return value.files.length===2?value:null;},'empty and invalid artifacts');
      await page.getByRole('tab',{name:'报告',exact:true}).click();await page.getByLabel('选择报告或图表').selectOption(listing.files.find(file=>file.kind==='markdown').id);await page.getByText('文件为空',{exact:true}).waitFor();
      await page.getByLabel('选择报告或图表').selectOption(listing.files.find(file=>file.kind==='png').id);await page.getByText('无法展示：PNG 文件无效',{exact:true}).waitFor();
      fixture.set({tool:{name:'write',args:{path:'report.md',content:'# Intentionally wrong answer\n\n1 + 1 = 9'}}},{text:'Finished.'});id=await submit(page);await settled(page,id);
      await page.getByRole('heading',{name:'Intentionally wrong answer'}).waitFor();assert((await page.locator('.artifact-markdown').innerText()).includes('1 + 1 = 9'));
      assert.deepEqual(app.errors,[]);return{executionSeparateFromFiles:true,missing:true,empty:true,damagedPng:true,semanticallyWrongReportStillDisplays:true};
    }finally{await app.stop();await fixture.close();}
  },
  async 'P4-LIVE-ANALYSIS'({ dir }) { return runScenario('J1-SALES', join(dir,'p4-live-sales')); },
  async 'P4-DETERMINISTIC'({ dir }) {
    const root = resolve(dir, 'p4-delivery'), exported = join(root, 'exported'); mkdirSync(exported, { recursive: true });
    const sourceA = join(root, 'sales.csv'), sourceB = join(root, 'regions.csv');
    writeFileSync(sourceA, 'region,amount\nN,10\nS,20\n'); writeFileSync(sourceB, 'region,label\nN,North\nS,South\n');
    const original = [sourceA,sourceB].map(path => readFileSync(path));
    const fixture = await modelFixture(), app = await startApp(root, { testModelBaseUrl: fixture.baseUrl, pickFiles: [sourceA,sourceB], exportDirectory: exported });
    try {
      const page = app.page; await configure(page); await page.getByRole('button', { name: '添加 CSV 文件', exact: true }).click();
      const sessionId = await until(() => page.getByTestId('session-title').getAttribute('data-session-id'), 'session created for imported paths');
      await page.getByRole('button', { name: '移除文件 regions.csv', exact: true }).waitFor();
      const script = String.raw`from pathlib import Path
import pandas as pd
import matplotlib.pyplot as plt
left = pd.read_csv(${JSON.stringify(sourceA)})
right = pd.read_csv(${JSON.stringify(sourceB)})
combined = left.merge(right,on='region')
Path('figures').mkdir(exist_ok=True)
plt.bar(combined['label'], combined['amount']); plt.title('地区销售'); plt.savefig('figures/chart.png'); plt.close()
Path('report.md').write_text('# Delivery report\n\nThis content is not a business correctness assertion.\n\n![地区销售](figures/chart.png)\n',encoding='utf-8')
`;
      fixture.set({ tool: { name: 'read', args: { path: sourceA } } }, { tool: { name: 'read', args: { path: sourceB } } }, { tool: { name: 'write', args: { path: 'analysis.py', content: script } } }, { tool: { name: 'bash', args: { command: 'python3 analysis.py' } } }, { text: 'Report and chart delivered.' });
      await page.getByRole('textbox', { name: '分析需求' }).fill('分析两份文件并生成 report.md 与图表。'); await page.getByRole('button', { name: '发送分析需求', exact: true }).click();
      const final = await settled(page, sessionId); assert.equal(final.state,'completed',final.error ?? '');
      const listing = await until(async () => { const value = await rpc(page, { type: 'artifacts.list', sessionId }); return value.files.length === 3 ? value : null; }, 'three generated artifacts registered');
      assert(listing.files.every(file => file.state === 'ready')); assert(listing.files.every(file => file.path.startsWith(final.outputDirectory+'/')));
      assert(final.outputDirectory.includes(`/runs/${final.runId}/versions/`));
      assert.equal(readFileSync(join(final.outputDirectory,'report.md'),'utf8').length > 0,true);
      assert(fixture.requests[0].messages.some(message => message.role === 'system' && message.content.includes('data-analysis') && message.content.includes('SKILL.md')));
      assert(!fixture.requests[0].messages.some(message => String(message.content).includes('N,10')));
      await page.getByRole('complementary', { name: '结果面板' }).waitFor();
      await page.getByRole('tab', { name: '报告', exact: true }).click();
      await page.getByRole('heading', { name: 'Delivery report', exact: true }).waitFor();
      const image = page.getByRole('img', { name: '地区销售', exact: true });
      await until(() => image.evaluate(element => element.complete && element.naturalWidth > 0), 'real PNG decoded in report preview');
      assert.equal(await page.locator('[data-run-state="completed"]').innerText(),'执行完成');
      await page.getByRole('button', { name: '导出这一版', exact: true }).click(); await page.getByRole('status').filter({ hasText: '已导出：' }).waitFor();
      const exportRoot = join(exported,readdirSync(exported)[0]);
      assert.equal(readFileSync(join(exportRoot,'report.md'),'utf8'),readFileSync(join(final.outputDirectory,'report.md'),'utf8'));
      assert(statSync(join(exportRoot,'figures/chart.png')).size > 100); assert(!existsSync(join(exportRoot,'sales.csv')));
      for(let i=0;i<2;i++)assert.deepEqual(readFileSync([sourceA,sourceB][i]),original[i]);
      await page.screenshot({ path: join(root,'report-chart.png'), fullPage:true });
      assert.deepEqual(app.errors,[]);
      const evidence={version:listing.versions[0].id, files:listing.files.map(file=>({path:file.relativePath,sha256:file.sha256})), reportRendered:true, imageDecoded:true, exportRelativeImageAvailable:true, sourcesUnchanged:true};
      writeFileSync(join(root,'delivery-evidence.json'),JSON.stringify(evidence,null,2));return evidence;
    } finally { await app.stop(); await fixture.close(); }
  },
};
