import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { startApp, until } from '../test/harness.mjs';
import { liveKey } from '../test/live-key.mjs';
import { configure, rpc } from '../../tests/e2e/p3.mjs';
import { scenarios } from '../../evaluations/fixtures/scenarios.mjs';

/** Prepare evidence only. The independent Judge must read it; no quality score is invented. */
export async function runScenario(id, root, { packaged = false } = {}) {
  const scenario = scenarios[id]; if (!scenario) throw new Error('Unknown evaluation scenario');
  root = resolve(root); mkdirSync(root, { recursive: true }); const sources = join(root,'sources'); mkdirSync(sources, { recursive: true });
  const paths=Object.entries(scenario.files).map(([name,text])=>{ const path=join(sources,name);writeFileSync(path,text);return path; });
  const key=liveKey(); let app, sessionId; const started=Date.now();
  const evidence={id,task:scenario.task,status:'running',judgeStatus:'not_reviewed',model:'deepseek-flash',provider:'deepseek',packaged,startedAt:new Date().toISOString(),commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),skillHash:createHash('sha256').update(readFileSync('resources/skills/data-analysis/SKILL.md')).digest('hex'),inputPaths:paths};
  const sourceHash=createHash('sha256');
  for(const file of execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{encoding:'utf8'}).split('\0').filter(Boolean).sort()) if(existsSync(file)) sourceHash.update(file).update('\0').update(readFileSync(file)).update('\0');
  evidence.sourceTreeHash=sourceHash.digest('hex');
  writeFileSync(join(root,'evaluation.json'),JSON.stringify(evidence,null,2));
  try {
    app=await startApp(join(root,'application'),{packaged,pickFiles:paths});const page=app.page;await configure(page,key);
    await page.getByRole('button',{name:'添加 CSV 文件',exact:true}).click();
    await page.getByRole('button',{name:`移除文件 ${Object.keys(scenario.files).at(-1)}`,exact:true}).waitFor();
    sessionId=await until(()=>page.getByTestId('session-title').getAttribute('data-session-id'),'imported session');
    await page.getByRole('textbox',{name:'分析需求'}).fill(scenario.task);await page.getByRole('button',{name:'发送分析需求',exact:true}).click();
    const final=await waitReviewedRun(page,sessionId,root,evidence);
    evidence.final=final;evidence.sessionId=sessionId;evidence.sessionFile=join(root,'application/data/sessions',`${sessionId}.jsonl`);
    assert.equal(final.state,'completed',final.error??'Agent did not finish');
    const listing=await until(async()=>{const value=await rpc(page,{type:'artifacts.list',sessionId});return value.versions.some(version=>version.runId===final.runId&&version.state==='published')?value:null;},'analysis artifacts published');
    const files=listing.files.filter(file=>file.runId===final.runId), report=files.find(file=>file.relativePath==='report.md'&&file.size>0&&file.state==='ready'), chart=files.find(file=>file.kind==='png'&&file.size>0&&file.state==='ready');
    evidence.artifacts=files;assert(report,'nonempty report.md required by fixture');assert(chart,'displayable PNG required by fixture');
    await page.getByRole('complementary',{name:'结果面板'}).waitFor();await page.getByRole('tab',{name:'报告',exact:true}).click();
    await page.getByLabel('选择报告或图表').selectOption(report.id);await page.locator('.artifact-markdown').waitFor();
    assert((await page.locator('.artifact-markdown').innerText()).length>0);
    await page.screenshot({path:join(root,'report.png'),fullPage:true});
    await page.getByLabel('选择报告或图表').selectOption(chart.id);
    await until(()=>page.locator('.artifact-scroll > .artifact-image').evaluate(element=>element.complete&&element.naturalWidth>0),'actual chart preview',30_000);
    await page.screenshot({path:join(root,'chart.png'),fullPage:true});
    for(const [name,text]of Object.entries(scenario.files))assert.equal(readFileSync(join(sources,name),'utf8'),text);
    assert.deepEqual(app.errors,[]);assert(!JSON.stringify(final).includes(key));assert(!readFileSync(evidence.sessionFile,'utf8').includes(key));
    evidence.status='passed';evidence.programChecks={reportNonempty:true,pngDisplayed:true,reportDisplayed:true,originalFilesUnchanged:true,analysisAccuracyChecked:false};
  } catch(error){evidence.status='failed';evidence.error=String(error.stack??error).replaceAll(key,'[REDACTED]');}
  finally {await app?.stop();evidence.elapsedMs=Date.now()-started;writeFileSync(join(root,'evaluation.json'),JSON.stringify(evidence,null,2));}
  if(evidence.status!=='passed')throw new Error(evidence.error);
  return {evaluationId:id,evidence:join(root,'evaluation.json'),programChecks:evidence.programChecks,judgeStatus:evidence.judgeStatus};
}

/** Explicit review decisions always travel through the actual approval UI. */
export async function waitReviewedRun(page,sessionId,root,evidence,previousRunId) {
  const reviewed=new Set(), answered=new Set(); evidence.reviewedApprovals=[];
  const reviewMode=process.env.DATA_AGENT_EVAL_REVIEW==='1';
  evidence.reviewMode=reviewMode;
  return until(async()=>{
      const value=await rpc(page,{type:'runtime.snapshot',sessionId});
      if(value?.interactions?.length) {
        evidence.pendingInteractions=value.interactions;
        writeFileSync(join(root,'pending-interactions.json'),JSON.stringify({sessionId,outputDirectory:value.outputDirectory,interactions:value.interactions},null,2));
        if(!reviewMode) throw new Error('Scenario needs human interaction; evidence retained for review.');
        for(const interaction of value.interactions) {
          if(answered.has(interaction.id))continue;
          if(!reviewed.has(interaction.id)){console.log(`Review required: ${join(root,'pending-interactions.json')}`);reviewed.add(interaction.id);}
          const decisionPath=join(root,`review-${interaction.id}.json`);
          if(!existsSync(decisionPath))continue;
          const decision=JSON.parse(readFileSync(decisionPath,'utf8'));
          assert.equal(decision.digest,interaction.digest);assert(interaction.kind==='approval'&&['allow_once','deny'].includes(decision.decision)&&typeof decision.reason==='string');
          await page.locator(`[data-interaction-id="${interaction.id}"]`).getByRole('button',{name:decision.decision==='allow_once'?'允许这一次':'拒绝',exact:true}).click();
          answered.add(interaction.id);
          evidence.reviewedApprovals.push({id:interaction.id,digest:interaction.digest,decision:decision.decision,reason:decision.reason});
          writeFileSync(join(root,'evaluation.json'),JSON.stringify(evidence,null,2));
        }
      }
      return value&&value.runId!==previousRunId&&['completed','failed','cancelled','interrupted'].includes(value.state)?value:null;
    },'real analysis task finished',reviewMode?900_000:300_000);
}
