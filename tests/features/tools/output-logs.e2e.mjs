import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { modelFixture } from '../../../scripts/test/model-fixture.mjs';
import { configure, submit, settled, openExecutionProcesses } from '../../support/desktop.mjs';

export const cases = {
  async 'tools.output-logs'({ dir }) {
    const root = join(dir, 'output-logs');
    const fixture = await modelFixture();
    let app, logPath, saved;
    try {
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      const page = app.page;
      await configure(page);
      fixture.set(
        { tool: { name: 'bash', args: { command: 'printf SMALL_OUTPUT' } } },
        (payload) => {
          assert.equal(payload.messages.at(-1).content, 'SMALL_OUTPUT');
          assert.deepEqual(readdirSync(join(root, 'data/logs')), []);
          return {
            tool: {
              name: 'bash',
              args: {
                command:
                  'python3 -c \'import sys,time; print("OUTPUT_BEGIN"); print("正文" * 1000); time.sleep(.1); print("STDERR_END_SENTINEL", file=sys.stderr)\'',
              },
            },
          };
        },
        (payload) => {
          const result = payload.messages.at(-1).content;
          assert(result.includes('截断'));
          assert(!result.includes('STDERR_END_SENTINEL'));
          assert(!result.includes('\ufffd'));
          assert(Buffer.byteLength(result.split('\n[输出已截断')[0]) <= 2048);
          logPath = result.match(/日志路径：([^\n]+)/)?.[1];
          assert(logPath?.startsWith(join(root, 'data/logs') + '/'));
          saved = readFileSync(logPath, 'utf8');
          assert(saved.startsWith('OUTPUT_BEGIN\n'));
          assert(saved.includes('正文'.repeat(1000)));
          assert(saved.endsWith('STDERR_END_SENTINEL\n'));
          return { tool: { name: 'read', args: { path: logPath } } };
        },
        (payload) => {
          assert.equal(payload.messages.at(-1).content, saved);
          return { text: 'READ_OVERFLOW_LOG_SUCCESS' };
        },
      );
      const sessionId = await submit(page, 'Exercise small output and read an overflow log.');
      const final = await settled(page, sessionId);
      assert.equal(final.state, 'completed', final.error);
      assert.equal(fixture.requests.length, 4);
      for (let i = 1; i < fixture.requests.length; i++) {
        const previous = fixture.requests[i - 1],
          current = fixture.requests[i];
        assert.deepEqual(current.messages.slice(0, previous.messages.length), previous.messages);
        assert.deepEqual(current.tools, previous.tools);
      }
      const large = final.tools.find((t) => t.name === 'bash' && t.output.includes('截断'));
      assert(large);
      await openExecutionProcesses(page);
      const card = page.locator(`[data-tool-id="${large.id}"]`);
      await card.locator('summary').click();
      await card.getByRole('heading', { name: '结果', exact: true }).waitFor();
      assert.equal(
        await page.getByRole('button', { name: '查看完整日志', exact: true }).count(),
        0,
      );
      assert.equal(
        await page.getByRole('region', { name: '完整工具日志', exact: true }).count(),
        0,
      );
      assert.equal(await page.getByTestId('full-tool-log').count(), 0);
      const resultText = await card.locator('pre').last().innerText();
      assert(!resultText.includes('STDERR_END_SENTINEL'));
      assert(resultText.includes(logPath));
      for (const [width, height] of [
        [1080, 760],
        [1280, 900],
        [1600, 1000],
      ]) {
        await page.setViewportSize({ width, height });
        const button = page.getByRole('button', { name: /切换到.*模式/, exact: true });
        for (const theme of ['initial', 'alternate']) {
          await card.screenshot({ path: join(dir, `output-log-${width}-${theme}.png`) });
          assert.equal(await card.locator('.tool-log').count(), 0);
          await button.click();
        }
      }
      // Removed log IPC must remain unavailable, even to a trusted application frame.
      const removed = await page.evaluate(
        ({ sessionId, toolCallId }) =>
          window.dataAgent.request({
            type: 'logs.list',
            sessionId,
            toolCallId,
          }),
        { sessionId, toolCallId: large.id },
      );
      assert.equal(removed.ok, false);
      assert.equal(removed.error.code, 'INVALID_COMMAND');
      await page.getByText('READ_OVERFLOW_LOG_SUCCESS', { exact: true }).waitFor();
      await until(
        () => readdirSync(join(root, 'data/logs', sessionId)).length === 1,
        'one overflow log',
      );
      assert.deepEqual(app.errors, []);
      return {
        smallOutputNotLogged: true,
        overflowReadByAgent: true,
        noLogUI: true,
        stableRequestPrefixes: true,
      };
    } finally {
      await app?.stop();
      await fixture.close();
    }
  },
};
