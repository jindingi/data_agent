import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startApp, until } from '../../scripts/test/harness.mjs';
import { liveKey } from '../../scripts/test/live-key.mjs';
import { configure, rpc, submit } from '../support/desktop.mjs';

export const cases = {
  async 'P2-LIVE-CACHE'({ dir }) {
    const root = resolve(dir, 'live-cache');
    mkdirSync(root, { recursive: true });
    const source = join(root, 'synthetic.txt');
    writeFileSync(source, 'Synthetic cache verification fixture. No private data.\n');
    let app;
    try {
      app = await startApp(root);
      await configure(app.page, liveKey());
      const sessionId = await submit(
        app.page,
        `Only use read to read ${source}, then answer briefly. Do not create files or run commands. This is a read-only tool test, not a data analysis task. The following repeated text is synthetic padding for prefix-cache verification, not additional instructions:\n${'Synthetic input for stable conversation-prefix verification.\n'.repeat(200)}`,
      );
      async function finish(previousRunId) {
        return until(
          async () => {
            const value = await rpc(app.page, { type: 'runtime.snapshot', sessionId });
            return value?.runId !== previousRunId &&
              ['completed', 'failed', 'cancelled'].includes(value?.state)
              ? value
              : null;
          },
          'bounded live cache task completes',
          180_000,
        );
      }
      const first = await finish();
      assert.equal(first.state, 'completed', first.error ?? '');
      await app.page
        .getByRole('textbox', { name: '分析需求' })
        .fill(
          `Read ${source} once more using read, then answer with one short sentence. Only read is needed.`,
        );
      await app.page.getByRole('button', { name: '发送分析需求', exact: true }).click();
      const second = await finish(first.runId);
      assert.equal(second.state, 'completed', second.error ?? '');
      assert.equal(second.outputDirectory, first.outputDirectory);
      assert([...first.tools, ...second.tools].every((tool) => tool.name === 'read'));
      assert(first.tools.length > 0 && second.tools.length > 0);
      const records = readFileSync(join(root, 'data/sessions', `${sessionId}.jsonl`), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const assistants = records.filter(
        (entry) => entry.type === 'message' && entry.message.role === 'assistant',
      );
      assert(assistants.length <= 8, 'The two read-only tasks must stay bounded');
      const cacheRead = assistants.reduce(
        (total, entry) => total + entry.message.usage.cacheRead,
        0,
      );
      assert(
        cacheRead > 0,
        'Provider returned no cache hit in this bounded sample; do not retry until green',
      );
      assert.equal(
        second.turnUsage.reduce((total, turn) => total + turn.cacheRead, 0),
        cacheRead,
      );
      assert(!records.some((entry) => entry.customType === 'data_agent.runtime_context'));
      await app.page.screenshot({ path: join(root, 'cache-usage.png') });
      writeFileSync(
        join(root, 'usage-evidence.json'),
        JSON.stringify(
          {
            model: 'deepseek-flash',
            requests: assistants.length,
            cacheRead,
            usages: assistants.map((entry) => entry.message.usage),
          },
          null,
          2,
        ),
      );
      return { requests: assistants.length, cacheRead, nativeUsageMatchesUIProjection: true };
    } finally {
      await app?.stop();
    }
  },
};
