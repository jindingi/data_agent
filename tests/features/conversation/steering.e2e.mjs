import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
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

const barrier = {
  name: 'bash',
  args: { command: 'while [ ! -f release ]; do sleep 0.1; done; printf first > report.md' },
};
export const cases = {
  async 'conversation.steering'({ dir }) {
    const root = resolve(dir, 'p5-steer'),
      fixture = await modelFixture();
    let app;
    try {
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      const page = app.page;
      await configure(page);
      let output;
      fixture.set(
        {
          tools: [
            barrier,
            { name: 'write', args: { path: 'batch-second.txt', content: 'second' } },
          ],
        },
        (payload) => {
          assert.equal(readFileSync(join(output, 'report.md'), 'utf8'), 'first');
          assert.equal(readFileSync(join(output, 'batch-second.txt'), 'utf8'), 'second');
          assert.equal(payload.messages.filter((m) => m.role === 'tool').length, 2);
          assert(
            payload.messages.some(
              (m) => m.role === 'user' && JSON.stringify(m.content).includes('steer-after-batch'),
            ),
          );
          return { text: 'Steering consumed after both tools.' };
        },
      );
      const sessionId = await submit(page, 'Run two tools as one batch.');
      const active = await runningTool(page, sessionId);
      output = active.outputDirectory;
      await send(page, 'steer-after-batch', 'steer');
      assert.equal(fixture.requests.length, 1);
      assert(!existsSync(join(output, 'batch-second.txt')));
      writeFileSync(join(output, 'release'), 'release');
      const final = await settled(page, sessionId);
      assert.equal(final.state, 'completed');
      assert.equal(
        final.inputs.filter((i) => i.kind === 'steer' && i.state === 'committed').length,
        1,
      );
      assert.equal(final.outputDirectory, output);
      assert.deepEqual(
        fixture.requests[1].messages.slice(0, fixture.requests[0].messages.length),
        fixture.requests[0].messages,
      );
      return { batchCompletedBeforeSteer: true, steerCommittedOnce: true, sameOutputVersion: true };
    } finally {
      await app?.stop();
      await fixture.close();
    }
  },
};
