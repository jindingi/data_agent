import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { prepareArtifacts, artifactOptions } from '../build/artifacts.mjs';
import { withRunContext } from '../test/run-context.mjs';
import { liveKey } from '../test/live-key.mjs';
import { startApp } from '../test/harness.mjs';
import { configure, rpc, selectSession } from '../../tests/support/desktop.mjs';
import { waitReviewedRun } from '../eval/run-scenario.mjs';

const args = process.argv.slice(2).filter((a) => a !== '--');
const take = (name) => {
  const index = args.indexOf(name);
  if (index < 0) throw new Error(`Required ${name}`);
  const value = args[index + 1];
  args.splice(index, 2);
  if (!value || value.startsWith('--')) throw new Error(`Missing ${name}`);
  return value;
};
const input = resolve(take('--input'));
const root = resolve(take('--output'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const original = readFileSync(input);
if (hash(original) !== 'df1f4ad2027a5a14c3a33932ef0d4054565ff88adf92b7f263601b70fdc6f3f3')
  throw new Error('Unexpected Netflix input snapshot');
mkdirSync(root, { recursive: true });
process.env.DATA_AGENT_TEST_MODEL_MODE = 'live';
const artifacts = prepareArtifacts(artifactOptions(args));
const tasks = JSON.parse(readFileSync(new URL('./tasks.json', import.meta.url), 'utf8'));
await withRunContext(artifacts, async () => {
  let app;
  const key = liveKey();
  try {
    app = await startApp(join(root, 'application'));
    await configure(app.page, key);
    const current = await rpc(app.page, { type: 'agentConfig.get' });
    if (
      !current.current.config.systemPrompt.endsWith(
        '请用中文解释数据口径，并保留可以复跑的分析脚本。',
      )
    )
      await rpc(app.page, {
        type: 'agentConfig.save',
        expectedRevision: current.current.revision,
        config: {
          ...current.current.config,
          systemPrompt:
            current.current.config.systemPrompt +
            '\n请用中文解释数据口径，并保留可以复跑的分析脚本。',
        },
      });
    for (const task of tasks) {
      const dir = join(root, task.id);
      mkdirSync(dir, { recursive: true });
      const priorPath = join(dir, 'evidence.json');
      const prior = existsSync(priorPath) ? JSON.parse(readFileSync(priorPath, 'utf8')) : undefined;
      if (prior?.status === 'completed') continue;
      if (prior) copyFileSync(priorPath, join(dir, `evidence-${Date.now()}.json`));
      const session = prior
        ? (await rpc(app.page, { type: 'sessions.open', sessionId: prior.sessionId })).session
        : await rpc(app.page, { type: 'sessions.create' });
      await rpc(app.page, { type: 'sessions.rename', sessionId: session.id, title: task.title });
      mkdirSync(join(session.workspace, 'data'), { recursive: true });
      const source = join(session.workspace, 'data/netflix_titles.csv');
      if (!prior) copyFileSync(input, source);
      await selectSession(app.page, session.id);
      const evidence = {
        id: task.id,
        task: task.prompt,
        model: 'deepseek-flash',
        provider: 'deepseek',
        startedAt: new Date().toISOString(),
        commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        sessionId: session.id,
        sessionFile: session.sessionFile,
        workspace: session.workspace,
        inputSha256: hash(original),
        artifactsContext: artifacts,
        status: 'running',
      };
      writeFileSync(join(dir, 'evidence.json'), JSON.stringify(evidence, null, 2));
      console.log(`Generating ${task.id}: ${dir}`);
      try {
        const previous = await rpc(app.page, { type: 'runtime.snapshot', sessionId: session.id });
        await app.page
          .getByRole('textbox', { name: '分析需求' })
          .fill(
            prior
              ? '上次因 net::ERR_NETWORK_CHANGED 中断。请依据已经完成的数据检查，继续尚未完成的脚本、报告和交付核验，不要重复已有分析。原任务的来源署名、口径、相对路径和交付要求继续有效。'
              : task.prompt,
          );
        await app.page.getByRole('button', { name: '发送分析需求', exact: true }).click();
        const final = await waitReviewedRun(app.page, session.id, dir, evidence, previous?.runId);
        evidence.final = final;
        if (final.state !== 'completed') throw new Error(final.error ?? final.state);
        if (readFileSync(join(session.workspace, task.report)).length === 0)
          throw new Error('Empty report');
        if (hash(readFileSync(source)) !== hash(original)) throw new Error('Input modified');
        if (readFileSync(session.sessionFile, 'utf8').includes(key))
          throw new Error('Credential in history');
        evidence.binding = (
          await rpc(app.page, { type: 'sessions.agentConfig', sessionId: session.id })
        ).binding;
        evidence.status = 'completed';
      } catch (error) {
        evidence.status = 'failed';
        evidence.error = String(error.stack ?? error).replaceAll(key, '[REDACTED]');
        throw error;
      } finally {
        writeFileSync(join(dir, 'evidence.json'), JSON.stringify(evidence, null, 2));
      }
      console.log(`Completed ${task.id}`);
    }
  } finally {
    await app?.stop();
  }
});
