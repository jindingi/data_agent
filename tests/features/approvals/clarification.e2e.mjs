import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { rpc, configure, submit, settled } from '../../support/desktop.mjs';
import { modelFixture } from '../../../scripts/test/model-fixture.mjs';

async function interaction(page, sessionId, kind = 'approval') {
  await page
    .getByRole('region', { name: kind === 'approval' ? '安全审批' : '澄清问题', exact: true })
    .waitFor({ timeout: 30_000 });
  return until(
    async () =>
      (await rpc(page, { type: 'runtime.snapshot', sessionId }))?.interactions?.find(
        (value) => value.kind === kind,
      ),
    'interaction in authoritative snapshot',
  );
}

async function late(page, value, changes = {}) {
  const response = await page.evaluate((command) => window.dataAgent.request(command), {
    type: 'interaction.answer',
    interactionId: value.id,
    sessionId: value.sessionId,
    runId: value.runId,
    digest: value.digest,
    answer: {
      kind: value.kind,
      ...(value.kind === 'approval' ? { decision: 'allow_once' } : { answer: 'late' }),
    },
    ...changes,
  });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'INTERACTION_EXPIRED');
}
export const cases = {
  async 'approvals.clarification'({ dir }) {
    const fixture = await modelFixture();
    const app = await startApp(join(dir, 'p3-question'), { testModelBaseUrl: fixture.baseUrl });
    try {
      const page = app.page;
      await configure(page);
      for (const mode of ['answer', 'refuse', 'cancel']) {
        fixture.set(
          {
            tool: {
              name: 'ask_clarification',
              args: { question: '按哪种口径统计？', options: ['含税金额', '不含税金额'] },
            },
          },
          { text: 'Clarification received.' },
        );
        const sessionId = await submit(page),
          pending = await interaction(page, sessionId, 'clarification');
        assert.equal(await page.getByRole('button', { name: '允许这一次' }).count(), 0);
        await late(page, pending, { answer: { kind: 'approval', decision: 'allow_once' } });
        if (mode === 'answer') {
          await page.getByRole('button', { name: '不含税金额', exact: true }).click();
          await page.getByRole('button', { name: '提交回答', exact: true }).click();
        }
        if (mode === 'refuse')
          await page.getByRole('button', { name: '暂不回答', exact: true }).click();
        if (mode === 'cancel')
          await page.getByRole('button', { name: '停止', exact: true }).click();
        const final = await settled(page, sessionId);
        await late(page, pending);
        if (mode === 'answer')
          assert(
            fixture.requests
              .at(-1)
              .messages.some(
                (message) =>
                  message.role === 'tool' &&
                  message.content.includes('不含税金额') &&
                  message.content.includes('clarification'),
              ),
          );
        if (mode === 'refuse')
          assert(final.tools.some((tool) => tool.output.includes('"answer":null')));
        if (mode === 'cancel') assert.equal(final.state, 'cancelled');
      }
      assert.deepEqual(app.errors, []);
      return {
        structuredAnswerInProviderRequest: true,
        refusal: true,
        cancel: true,
        cannotGrantApproval: true,
      };
    } finally {
      await app.stop();
      await fixture.close();
    }
  },
};
