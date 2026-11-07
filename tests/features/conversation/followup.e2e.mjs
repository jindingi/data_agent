import { workspaceFiles } from '../../support/desktop.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { modelFixture } from '../../../scripts/test/model-fixture.mjs';
import { rpc, configure, submit, settled } from '../../support/desktop.mjs';

async function send(page, text, kind) {
  if (kind) await page.getByLabel('运行中输入方式').selectOption(kind);
  await page.getByRole('textbox', { name: '分析需求' }).fill(text);
  await page.getByRole('button', { name: '发送分析需求', exact: true }).click();
  await until(
    () =>
      page
        .getByRole('textbox', { name: '分析需求' })
        .inputValue()
        .then((value) => value === ''),
    'input accepted',
  );
}

async function runningTool(page, sessionId) {
  return until(async () => {
    const s = await rpc(page, { type: 'runtime.snapshot', sessionId });
    return s?.tools.some((t) => t.name === 'bash' && t.status === 'running') ? s : null;
  }, 'real tool started');
}

async function listing(page, sessionId) {
  return until(async () => {
    const files = await workspaceFiles(page, sessionId);
    return files.length ? files : null;
  }, 'workspace files available');
}

const writeReport = (content) => ({
  tool: { name: 'write', args: { path: 'report.md', content } },
});

const barrier = {
  name: 'bash',
  args: { command: 'while [ ! -f release ]; do sleep 0.1; done; printf first > report.md' },
};
export const cases = {
  async 'conversation.followup'({ dir }) {
    const root = resolve(dir, 'p5-followup'),
      fixture = await modelFixture();
    let app;
    try {
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      const page = app.page;
      await configure(page);
      fixture.set(
        { tool: barrier },
        { text: 'First finished.' },
        writeReport('# Followup 1'),
        { text: 'Followup 1 finished.' },
        writeReport('# Followup 2'),
        { text: 'Followup 2 finished.' },
      );
      const sessionId = await submit(page, 'Start then wait for followups.'),
        active = await runningTool(page, sessionId);
      await send(page, 'same followup text', 'followUp');
      await send(page, 'same followup text', 'followUp');
      const queued = await rpc(page, { type: 'runtime.snapshot', sessionId });
      assert.equal(queued.queuedInputs.filter((i) => i.kind === 'followUp').length, 2);
      writeFileSync(join(active.outputDirectory, 'release'), 'release');
      const final = await settled(page, sessionId);
      assert.equal(final.state, 'completed');
      assert.equal(final.runId, active.runId);
      const followups = final.inputs.filter((i) => i.kind === 'followUp');
      assert.equal(followups.length, 2);
      assert(followups.every((i) => i.state === 'committed'));
      assert.equal(new Set(followups.map((i) => i.entryId)).size, 2);
      assert.equal(
        final.messages.filter(
          (m) =>
            m.role === 'user' &&
            m.blocks.some((b) => b.type === 'text' && b.text === 'same followup text'),
        ).length,
        2,
      );
      assert.deepEqual(final.queuedInputs, []);
      const outputs = await listing(page, sessionId, 1),
        reports = outputs.filter((f) => f.relativePath === 'report.md');
      assert.deepEqual(
        reports.map((f) => readFileSync(join(final.outputDirectory, f.relativePath), 'utf8')),
        ['# Followup 2'],
      );
      assert.equal(final.outputDirectory, active.outputDirectory);
      assert.equal(fixture.requests.length, 6);
      assert.equal(fixture.requests[2].messages.filter((m) => m.role === 'user').length, 2);
      assert.equal(fixture.requests[4].messages.filter((m) => m.role === 'user').length, 3);
      for (let i = 1; i < fixture.requests.length; i++) {
        assert.deepEqual(
          fixture.requests[i].messages.slice(0, fixture.requests[i - 1].messages.length),
          fixture.requests[i - 1].messages,
        );
        assert.deepEqual(fixture.requests[i].tools, fixture.requests[0].tools);
      }
      assert(!JSON.stringify(fixture.requests).includes('剩余最多'));
      await page.screenshot({ path: join(root, 'followup.png'), fullPage: true });
      assert.deepEqual(app.errors, []);
      return {
        sameRun: true,
        distinctInputIds: true,
        consumedOnceInOrder: true,
        sharedWorkspace: true,
        stableRequestPrefix: true,
      };
    } finally {
      await app?.stop();
      await fixture.close();
    }
  },
};
