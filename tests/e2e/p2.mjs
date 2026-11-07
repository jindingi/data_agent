import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { startApp, until } from '../../scripts/test/harness.mjs';
import { liveKey } from '../../scripts/test/live-key.mjs';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';

const scenarios = new Map();
function markdownText(markdown) {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
  const text = (node) =>
    ['text', 'inlineCode', 'code'].includes(node.type)
      ? node.value
      : (node.children ?? []).map(text).join('');
  return text(tree).replace(/\s/g, '');
}
async function snapshot(page, sessionId) {
  const result = await page.evaluate(
    (sessionId) => window.dataAgent.request({ type: 'runtime.snapshot', sessionId }),
    sessionId,
  );
  assert.equal(result.ok, true);
  return result.value;
}
function audit(root, key) {
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'userData') audit(path, key);
    } else
      assert.equal(
        readFileSync(path).includes(Buffer.from(key)),
        false,
        `Credential leak in ${name}`,
      );
  }
}
async function liveScenario(dir) {
  if (scenarios.has(dir)) return scenarios.get(dir);
  const work = (async () => {
    const root = join(dir, 'p2-live');
    mkdirSync(root, { recursive: true });
    const key = liveKey();
    const nonce = randomUUID();
    const sourceA = join(root, 'regions.csv'),
      sourceB = join(root, 'rates.csv');
    const textA = `region,previous,current\nNorth,93,70\nSouth,51,65\nEast,82,80\nWest,45,37\nnonce,${nonce},0\n`;
    const textB = 'region,returns\nNorth,5\nSouth,2\nEast,6\nWest,1\n';
    writeFileSync(sourceA, textA);
    writeFileSync(sourceB, textB);
    let app;
    try {
      app = await startApp(root, { pickFiles: [sourceA, sourceB] });
      const page = app.page;
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page
        .getByLabel('选择模型')
        .selectOption(JSON.stringify({ provider: 'deepseek', model: 'deepseek-flash' }));
      const keyField = page.getByRole('textbox', { name: 'API key' });
      try {
        await keyField.fill(key);
        await page.getByRole('button', { name: '保存凭证', exact: true }).click();
        await page
          .getByRole('status')
          .filter({ hasText: 'API key 已保存' })
          .waitFor({ timeout: 20_000 });
      } finally {
        await keyField.fill('').catch(() => {});
      }
      await page.getByRole('button', { name: '关闭对话框' }).click();
      await page.getByRole('button', { name: '添加 CSV 文件', exact: true }).click();

      await page
        .getByRole('textbox', { name: '分析需求' })
        .fill(
          `这是一个需要仔细推理的工具验证任务。请先用 read 读取 ${sourceA}，收到结果后再用 read 读取 ${sourceB}。比较各地区在退货调整前后可能的下降趋势，解释你采用的假设和资料限制，形成简短 Markdown 表格。nonce 行是测试标记，不参与业务比较。不需要生成文件。必须实际使用 read，不要猜测文件内容。本次仅验收只读对话链路，只使用 read 工具，不调用 bash、write 或其他工具；根据读取到的简短表格直接推理回答。`,
        );
      await page.getByRole('button', { name: '发送分析需求', exact: true }).click();
      const sessionId = await until(
        () => page.getByTestId('session-title').getAttribute('data-session-id'),
        'session selected',
      );
      await until(
        async () => {
          const value = await snapshot(page, sessionId);
          return value?.messages.some(
            (message) =>
              message.pending &&
              message.blocks.some(
                (block) =>
                  (block.type === 'thinking' && block.text) ||
                  (block.type === 'text' && block.text),
              ),
          );
        },
        'actual streamed partial',
        150_000,
      );
      await page.reload();
      await page.getByRole('textbox', { name: '分析需求' }).waitFor();
      await until(
        async () => (await page.locator('.history-message.assistant').count()) > 0,
        'active snapshot restored after reload',
        20_000,
      );
      const first = await until(
        async () => {
          const value = await snapshot(page, sessionId);
          return value && ['completed', 'failed', 'cancelled'].includes(value.state) ? value : null;
        },
        'first real model task settled',
        240_000,
      );
      assert.equal(first.state, 'completed', first.error ?? 'first run failed');
      assert(
        first.tools.some((tool) => tool.name === 'read' && tool.output.includes(nonce)),
        'read tool must return actual fixture contents',
      );
      assert(
        first.requests?.some((request) =>
          request.toolResultHashes.includes(createHash('sha256').update(textA).digest('hex')),
        ),
        'actual tool result must enter a later provider request',
      );
      assert(
        first.requests.every(
          (request) => request.model === 'deepseek-flash' && !request.hasInternalEnvelope,
        ),
      );
      assert(
        first.requests.every(
          (request) => request.thinkingEnabled && request.reasoningEffort === 'high',
        ),
      );
      await page.locator('.tool-card').first().locator('summary').click();
      assert((await page.locator('.tool-card').first().innerText()).includes('参数'));
      const assistantTexts = first.messages
        .filter((message) => message.role === 'assistant')
        .flatMap((message) =>
          message.blocks.filter((block) => block.type === 'text').map((block) => block.text),
        );
      assert(assistantTexts.some((text) => text.length > 0));
      for (const message of first.messages.filter((message) => message.role === 'assistant')) {
        const texts = message.blocks
          .filter((block) => block.type === 'text')
          .map((block) => block.text);
        const view = page.locator(`[data-message-id="${message.id}"] .markdown-body`);
        await until(async () => {
          if ((await view.count()) !== texts.length) return false;
          const actual = await view.allInnerTexts();
          return actual.every(
            (text, index) => text.replace(/\s/g, '') === markdownText(texts[index]),
          );
        }, 'rendered Markdown text matches SDK message content');
      }
      assert.equal(
        (await snapshot(page, sessionId)).messages.filter((message) => message.role === 'user')
          .length,
        1,
      );
      await page.screenshot({ path: join(root, 'live-stream-tools.png'), fullPage: true });
      await page
        .getByRole('textbox', { name: '分析需求' })
        .fill(
          '沿用刚才的上下文，简短说明已读取哪些文件，以及有哪些假设需要业务人员确认。无需重新读取文件。',
        );
      await page.getByRole('button', { name: '发送分析需求', exact: true }).click();
      const second = await until(
        async () => {
          const value = await snapshot(page, sessionId);
          return value &&
            value.runId !== first.runId &&
            ['completed', 'failed', 'cancelled'].includes(value.state)
            ? value
            : null;
        },
        'second real model task settled',
        240_000,
      );
      assert.equal(second.state, 'completed', second.error ?? 'second run failed');
      assert(
        second.requests.some(
          (request) =>
            request.userMessages >= 2 &&
            request.toolResultHashes.includes(createHash('sha256').update(textA).digest('hex')),
        ),
        'restored native history must enter actual next request',
      );
      const nonemptyThinking = first.messages.some((message) =>
        message.blocks.some((block) => block.type === 'thinking' && block.text.length > 0),
      );
      const reasoningForwarded = first.requests.some((request) => request.hasNonemptyReasoning);
      assert(first.usage?.totalTokens > 0 && second.usage?.totalTokens > 0);
      const file = join(root, 'data/sessions', `${sessionId}.jsonl`);
      const bytes = readFileSync(file, 'utf8');
      const entries = bytes
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.equal(
        entries.filter((entry) => entry.type === 'message' && entry.message.role === 'user').length,
        2,
      );
      assert.deepEqual(app.errors, []);
      await app.stop();
      app = await startApp(root);
      await until(
        () =>
          app.page
            .locator('.history-message.user')
            .count()
            .then((count) => count === 2),
        'native history restored in real window',
      );
      assert.equal(readFileSync(file, 'utf8'), bytes);
      assert((await app.page.locator('.tool-card').count()) >= 2);
      const settings = await app.page.evaluate(() =>
        window.dataAgent.request({ type: 'models.settings' }),
      );
      assert.equal(settings.ok, true);
      assert(settings.value.configuredProviders.includes('deepseek'));
      assert(!JSON.stringify(settings).includes(key));
      const evidence = {
        provider: 'deepseek',
        configuredModel: 'deepseek-flash',
        credentialSource: 'DEEPSEEK_API_KEY from environment or literal ~/.zshrc assignment',
        first: {
          requests: first.requests,
          usage: first.usage,
          responseModel: first.responseModel,
          readCalls: first.tools.filter((tool) => tool.name === 'read').length,
        },
        second: {
          requests: second.requests,
          usage: second.usage,
          responseModel: second.responseModel,
        },
        nonemptyThinking,
        reasoningForwarded,
        reloadDuringStream: true,
        restartHistoryPreserved: true,
        credentialRestoredEncrypted: true,
      };
      writeFileSync(join(root, 'live-evidence.json'), JSON.stringify(evidence, null, 2));
      await app.stop();
      app = undefined;
      audit(root, key);
      return evidence;
    } catch (error) {
      // eslint-disable-next-line preserve-caught-error -- The original cause may contain the live API key; retain only the redacted stack.
      throw new Error(String(error.stack ?? error).replaceAll(key, '[REDACTED]'));
    } finally {
      if (app) {
        await app.page
          .getByRole('textbox', { name: 'API key' })
          .fill('')
          .catch(() => {});
        await app.stop();
      }
    }
  })();
  scenarios.set(dir, work);
  return work;
}
export const cases = {
  async 'P2-LIVE-READ'({ dir }) {
    const evidence = await liveScenario(dir);
    return evidence.first;
  },
  async 'P2-LIVE-CONTEXT'({ dir }) {
    const evidence = await liveScenario(dir);
    return { ...evidence.second, restartHistoryPreserved: evidence.restartHistoryPreserved };
  },
  async 'P2-LIVE-THINKING'({ dir }) {
    const evidence = await liveScenario(dir);
    assert(
      evidence.nonemptyThinking && evidence.reasoningForwarded,
      'complex task must demonstrate real thinking and its tool continuation',
    );
    return { nonemptyThinking: true, reasoningForwarded: true };
  },
  async 'P2-CDP-LIVE'({ dir }) {
    const evidence = await liveScenario(dir);
    return {
      reloadDuringStream: evidence.reloadDuringStream,
      restartHistoryPreserved: evidence.restartHistoryPreserved,
      credentialRestoredEncrypted: evidence.credentialRestoredEncrypted,
    };
  },
};
