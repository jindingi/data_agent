import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
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

const barrier = {
  name: 'bash',
  args: { command: 'while [ ! -f release ]; do sleep 0.1; done; printf first > report.md' },
};
export const cases = {
  async 'lifecycle.stop'({ dir }) {
    const root = resolve(dir, 'p5-stop'),
      fixture = await modelFixture();
    let app;
    try {
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      const page = app.page;
      await configure(page);
      for (const kind of ['tool', 'approval', 'clarification']) {
        const operation =
          kind === 'tool'
            ? barrier
            : kind === 'approval'
              ? {
                  name: 'write',
                  args: { path: join(root, 'never-write.txt'), content: 'not approved' },
                }
              : {
                  name: 'ask_clarification',
                  args: { question: 'Choose a fixture option.', options: ['one', 'two'] },
                };
        fixture.set({ tool: operation }, { text: 'Must not be called after stop.' });
        const sessionId = await submit(page, `Stop while waiting for ${kind}.`);
        await until(async () => {
          const s = await rpc(page, { type: 'runtime.snapshot', sessionId });
          return kind === 'tool'
            ? s?.tools.some((t) => t.status === 'running')
            : s?.interactions?.length;
        }, 'pending work');
        await send(page, 'Unconsumed followup remains unsent.', 'followUp');
        const before = fixture.requests.length;
        await page.getByRole('button', { name: '停止', exact: true }).click();
        const final = await settled(page, sessionId);
        assert.equal(final.state, 'cancelled');
        assert.equal(final.inputs.find((i) => i.kind === 'followUp').state, 'cancelled');
        assert(final.unsentInputs.some((i) => i.text === 'Unconsumed followup remains unsent.'));
        assert.deepEqual(final.interactions, []);
        await delay(250);
        assert.equal(fixture.requests.length, before);
        assert(!existsSync(join(root, 'never-write.txt')));
        await page.getByText('未发送 · 后续提问', { exact: true }).waitFor();
      }
      const requestsBeforeRestart = fixture.requests.length;
      await app.stop();
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      const sessions = await rpc(app.page, { type: 'sessions.list' });
      for (const session of sessions) {
        const restored = await rpc(app.page, { type: 'runtime.snapshot', sessionId: session.id });
        assert.equal(restored.unsentInputs.length, 1);
        assert.equal(restored.unsentInputs[0].text, 'Unconsumed followup remains unsent.');
        assert(!restored.unsentInputs.some((i) => i.kind === 'prompt'));
      }
      assert.equal(fixture.requests.length, requestsBeforeRestart);
      return {
        toolApprovalClarificationCancelled: true,
        queueNotExecuted: true,
        unsentVisible: true,
        unsentRecoveredAfterQuit: true,
        committedDraftRemoved: true,
      };
    } finally {
      await app?.stop();
      await fixture.close();
    }
  },
};
