import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { modelFixture } from '../../../scripts/test/model-fixture.mjs';
import { configure, createStoredSession, rpc, settled } from '../../support/desktop.mjs';

export const cases = {
  async 'tools.output-budgets'({ dir }) {
    const fixture = await modelFixture();
    const root = join(dir, 'output-budgets');
    let app;
    try {
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      const page = app.page;
      await configure(page);
      const session = await createStoredSession(page);
      const names = join(session.workspace, 'files');
      mkdirSync(names);
      for (let i = 0; i < 500; i++)
        writeFileSync(join(names, String(i).padStart(4, '0') + 'x'.repeat(240)), '');
      const text = '中'.repeat(30_000) + '\nFINAL_SENTINEL\n';
      writeFileSync(join(session.workspace, 'long.txt'), text);
      let readBack = '';
      const errors = [];
      const checked = (reply) => (payload) => {
        try {
          return reply(payload);
        } catch (error) {
          errors.push(String(error));
          return { text: 'FIXTURE_ASSERTION_FAILED' };
        }
      };
      fixture.set(
        { tools: Array.from({ length: 8 }, () => ({ name: 'ls', args: { path: 'files' } })) },
        checked((payload) => {
          const results = payload.messages.filter((m) => m.role === 'tool');
          assert.equal(results.length, 8);
          assert(results.every((m) => Buffer.byteLength(m.content) <= 32 * 1024));
          assert(results.reduce((sum, m) => sum + Buffer.byteLength(m.content), 0) <= 256 * 1024);
          assert(results.every((m) => m.content.includes('offset=')));
          return { tool: { name: 'read', args: { path: 'long.txt' } } };
        }),
        checked((payload) => {
          const result = payload.messages.at(-1).content;
          readBack += result.split('\n[读取已截断')[0];
          const byteOffset = Number(result.match(/byteOffset=(\d+)/)?.[1]);
          assert(byteOffset > 0);
          return { tool: { name: 'read', args: { path: 'long.txt', byteOffset } } };
        }),
        checked((payload) => {
          readBack += payload.messages.at(-1).content;
          assert(
            readBack === text,
            JSON.stringify({
              actualLength: readBack.length,
              expectedLength: text.length,
              tail: readBack.slice(-150),
            }),
          );
          return {
            tool: {
              name: 'bash',
              args: { command: 'printf MUST_NOT_RUN', unexpected: '中'.repeat(30_000) },
            },
          };
        }),
        checked((payload) => {
          const output = payload.messages.at(-1).content;
          assert(Buffer.byteLength(output) <= 64 * 1024);
          assert(output.includes('Validation failed'));
          assert(output.includes('工具结果超过本次返回预算'));
          return {
            tools: Array.from({ length: 32 }, (_, i) => ({
              name: 'write',
              args: { path: `must-not-write-${i}.txt`, content: 'unexpected side effect' },
            })),
          };
        }),
        checked((payload) => {
          const results = payload.messages.slice(-32);
          assert(
            results.every((m) => m.role === 'tool' && m.content.includes('本批次工具调用过多')),
          );
          for (let i = 0; i < 32; i++)
            assert(!existsSync(join(session.workspace, `must-not-write-${i}.txt`)));
          return { text: 'BOUNDED_RESULTS_COMPLETE' };
        }),
      );
      await page
        .getByRole('textbox', { name: '分析需求' })
        .fill('Exercise bounded tool batches and UTF-8 continuation.');
      await page.getByRole('button', { name: '发送分析需求', exact: true }).click();
      const first = await until(async () => {
        const snapshot = await rpc(page, { type: 'runtime.snapshot', sessionId: session.id });
        return snapshot?.state === 'completed' ? snapshot : null;
      }, 'bounded tools complete');
      writeFileSync(join(root, 'wire-requests.json'), JSON.stringify(fixture.requests));
      assert.deepEqual(errors, []);
      assert.equal(fixture.requests.length, 6);
      fixture.set({ text: 'CONTINUED' });
      await app.stop();
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      await app.page
        .getByRole('textbox', { name: '分析需求' })
        .fill('Continue with the attached file.');
      await app.page.getByRole('button', { name: '发送分析需求', exact: true }).click();
      await until(
        async () =>
          (await rpc(app.page, { type: 'runtime.snapshot', sessionId: session.id }))?.runId !==
          first.runId,
        'new run',
      );
      assert.equal((await settled(app.page, session.id)).state, 'completed');
      writeFileSync(join(root, 'wire-requests.json'), JSON.stringify(fixture.requests));
      for (let i = 1; i < fixture.requests.length; i++) {
        const previous = fixture.requests[i - 1];
        for (let j = 0; j < previous.messages.length; j++)
          assert(
            JSON.stringify(fixture.requests[i].messages[j]) ===
              JSON.stringify(previous.messages[j]),
            `request ${i}, message ${j} changed`,
          );
        assert.deepEqual(fixture.requests[i].tools, previous.tools);
      }
      assert.deepEqual(app.errors, []);
      return {
        boundedFinalHttpBodies: true,
        exactUtf8Continuation: true,
        prefixesSurviveBudgetChangesAndRestart: true,
      };
    } finally {
      await app?.stop();
      await fixture.close();
    }
  },
};
