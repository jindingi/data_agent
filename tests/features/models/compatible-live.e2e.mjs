import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { liveKey } from '../../../scripts/test/live-key.mjs';
import { configureCompatible } from '../../support/compatible-models.mjs';
import { rpc, submit, snapshot } from '../../support/desktop.mjs';

async function validate({ dir }, provider, service) {
  const key = liveKey(service === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'OPENROUTER_API_KEY');
  const root = join(dir, `${provider}-${service}`);
  mkdirSync(root, { recursive: true });
  const source = join(root, 'synthetic.txt');
  const nonce = randomUUID();
  writeFileSync(source, `fixture value: ${nonce}\n`);
  let app;
  try {
    app = await startApp(root);
    const { page } = app;
    await configureCompatible(page, {
      provider,
      key,
      baseUrl: service === 'deepseek' ? 'https://api.deepseek.com' : 'https://openrouter.ai/api/v1',
      model: service === 'deepseek' ? 'deepseek-flash' : 'deepseek/deepseek-v4.1-flash',
      profile: service,
      reasoning: true,
      contextWindow: 1000000,
    });
    await rpc(page, { type: 'models.thinking', level: 'low' });
    const sessionId = await submit(
      page,
      `This is a bounded read-only protocol test. Use only read, exactly once, to read ${source}. Then reply with the fixture value and nothing else. Do not use any other tool or create files.`,
    );
    const done = await until(
      async () => {
        const s = await snapshot(page, sessionId);
        assert(
          !['waiting_approval', 'waiting_input'].includes(s?.state),
          'Unexpected interaction; no automatic approval',
        );
        assert((s?.requests?.length ?? 0) <= 4, 'Live test request budget exceeded');
        return s && ['completed', 'failed', 'cancelled'].includes(s.state) ? s : null;
      },
      'compatible live tool roundtrip',
      180000,
    );
    assert.equal(done.state, 'completed', done.error);
    assert(done.tools.some((t) => t.name === 'read' && t.output.includes(nonce)));
    assert(
      done.messages.some(
        (m) =>
          m.role === 'assistant' &&
          m.blocks.some((b) => b.type === 'text' && b.text.includes(nonce)),
      ),
    );
    assert(done.turnUsage.some((u) => u.calls >= 2 && u.totalTokens > 0));
    const historyPath = join(root, 'data/sessions', `${sessionId}.jsonl`);
    const before = readFileSync(historyPath, 'utf8');
    await app.stop();
    app = undefined;
    app = await startApp(root);
    const settings = await rpc(app.page, { type: 'models.settings' });
    assert.equal(settings.selected.provider, provider);
    assert.equal(readFileSync(historyPath, 'utf8'), before);
    await app.page
      .getByRole('textbox', { name: '分析需求', exact: true })
      .fill('Reply with that same fixture value from our history. Do not call any tools.');
    await app.page.getByRole('button', { name: '发送分析需求', exact: true }).click();
    const next = await until(
      async () => {
        const s = await snapshot(app.page, sessionId);
        return s?.runId !== done.runId && ['completed', 'failed', 'cancelled'].includes(s?.state)
          ? s
          : null;
      },
      'compatible restart followup',
      180000,
    );
    assert.equal(next.state, 'completed', next.error);
    assert(next.turnUsage.at(-1).totalTokens > 0);
    return { provider, service, toolRoundtrip: true, restart: true, usage: next.turnUsage };
  } catch (error) {
    // eslint-disable-next-line preserve-caught-error -- Provider and UI failures may contain a credential.
    throw new Error(
      String(error instanceof Error ? error.stack : error).replaceAll(key, '<REDACTED>'),
    );
  } finally {
    await app?.stop();
  }
}

export const cases = {
  'models.live-compatible-chat-deepseek': (ctx) =>
    validate(ctx, 'openai-chat-compatible', 'deepseek'),
  'models.live-compatible-responses-deepseek': (ctx) =>
    validate(ctx, 'openai-responses-compatible', 'deepseek'),
  'models.live-compatible-chat-openrouter': (ctx) =>
    validate(ctx, 'openai-chat-compatible', 'openrouter'),
  'models.live-compatible-responses-openrouter': (ctx) =>
    validate(ctx, 'openai-responses-compatible', 'openrouter'),
};
