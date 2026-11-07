import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { testAppDir } from '../../../scripts/test/run-context.mjs';
import { liveKey } from '../../../scripts/test/live-key.mjs';
import { modelCassette } from '../../support/model/cassette.mjs';
import { configure, createStoredSession, rpc } from '../../support/desktop.mjs';

async function scenario(dir, mode) {
  const root = resolve(dir, `model-${mode}`);
  mkdirSync(root, { recursive: true });
  const source = join(root, 'fixture.txt');
  writeFileSync(source, 'Synthetic fixture: North 10, South 20.\n');
  const file =
    mode === 'record'
      ? join(root, 'candidate.json')
      : resolve('tests/fixtures/model/read-tool.deepseek.json');
  const transport = await modelCassette({
    mode,
    file,
    key: mode === 'record' ? liveKey() : undefined,
    bindings: { TEST_ROOT: root, APP_ROOT: testAppDir(), REPO_ROOT: resolve('.') },
  });
  let app;
  try {
    app = await startApp(root, { testModelBaseUrl: transport.baseUrl });
    await configure(app.page, 'synthetic-record-replay-key');
    const session = await createStoredSession(app.page);
    transport.bind('WORKSPACE', session.workspace);
    await app.page
      .getByRole('textbox', { name: '分析需求' })
      .fill(
        `This is a read-only transport test, not data analysis. Call read exactly once on ${source}, then reply with the file contents in one sentence. Do not read skills, run commands, or write files.`,
      );
    await app.page.getByRole('button', { name: '发送分析需求', exact: true }).click();
    const value = await until(
      async () => {
        const s = await rpc(app.page, { type: 'runtime.snapshot', sessionId: session.id });
        return ['completed', 'failed', 'cancelled'].includes(s?.state) ? s : null;
      },
      'recorded tool turn settles',
      180_000,
    );
    assert.equal(value.state, 'completed', value.error ?? '');
    assert(value.tools.some((tool) => tool.name === 'read' && tool.output.includes('North 10')));
    assert(
      value.tools.every((tool) => tool.name === 'read'),
      'Fixture scenario is read-only',
    );
    assert(value.usage?.totalTokens > 0);
    assert(transport.exchanges.length >= 2, 'Tool continuation must reach the provider transport');
    transport.assertComplete();
    await app.page.getByRole('button', { name: /用量/ }).first().waitFor();
    const history = join(root, 'data/sessions', `${session.id}.jsonl`);
    const bytes = readFileSync(history, 'utf8');
    assert(bytes.includes('North 10'));
    await app.stop();
    app = await startApp(root, { testModelBaseUrl: transport.baseUrl });
    await until(
      () => app.page.locator('.history-message.assistant').count(),
      'recorded history restored',
    );
    assert.equal(readFileSync(history, 'utf8'), bytes);
    transport.assertComplete();
    if (mode === 'record') transport.save();
    return {
      mode,
      exchanges: transport.exchanges.length,
      totalTokens: value.usage.totalTokens,
      historyRestored: true,
      candidate: mode === 'record' ? file : undefined,
    };
  } finally {
    await app?.stop();
    await transport.close();
  }
}
export const cases = {
  'models.recorded-conversation': ({ dir }) => scenario(dir, 'replay'),
  'models.live-recording': ({ dir }) => scenario(dir, 'record'),
};
