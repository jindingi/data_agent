import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { liveKey } from '../../../scripts/test/live-key.mjs';
import { configure, submit, snapshot } from '../../support/desktop.mjs';

export const cases = {
  async 'tools.live-execution'({ dir }) {
    const key = liveKey(),
      root = resolve(dir, 'p3-live-tools'),
      nonce = randomUUID();
    let app;
    try {
      app = await startApp(root);
      await configure(app.page, key);
      const sessionId = await submit(
        app.page,
        `这是工作台工具集成验证。请实际调用 write 创建一个 Python 脚本，然后调用 bash 用内置 python3 执行，最后调用 read 读取生成的 report.md。脚本只在当前工作区创建 report.md 与 chart.png，不访问网络、不安装依赖、不读敏感路径。使用 pandas 和 matplotlib，图表标题用中文。report.md 非空并包含标记 ${nonce}。脚本还应打印 JSON 诊断：python=sys.executable、pandas=pandas.__version__、credentialInherited=any('API_KEY' in k for k in os.environ)，只输出布尔值，不输出任何环境变量值。文件路径请用字面量字符串；报告业务内容任意，不评价分析正确性。完成后说明文件路径。`,
      );
      const final = await until(
        async () => {
          const value = await snapshot(app.page, sessionId);
          if (value?.interactions?.length)
            throw new Error(
              'Live fixture unexpectedly requires interaction; inspect local evidence before approving.',
            );
          return value && ['completed', 'failed', 'cancelled', 'interrupted'].includes(value.state)
            ? value
            : null;
        },
        'actual DeepSeek write/bash/read complete',
        240_000,
      );
      assert.equal(final.state, 'completed', final.error ?? 'live task failed');
      for (const name of ['write', 'bash', 'read'])
        assert(
          final.tools.some((tool) => tool.name === name && tool.status === 'completed'),
          `Missing successful ${name}`,
        );
      const workspace = final.outputDirectory ?? join(root, 'data/workspace', sessionId),
        report = readFileSync(join(workspace, 'report.md'), 'utf8');
      assert(report.length > 0 && report.includes(nonce));
      assert(statSync(join(workspace, 'chart.png')).size > 100);
      assert(final.tools.some((tool) => tool.name === 'read' && tool.output.includes(nonce)));
      const bash = final.tools
        .filter((tool) => tool.name === 'bash')
        .map((tool) => tool.output)
        .join('\n');
      assert(bash.includes('runtime/darwin-arm64/python/bin/python3'));
      assert(/"credentialInherited"\s*:\s*false/.test(bash));
      assert(!JSON.stringify(final).includes(key));
      assert(
        !readFileSync(join(root, 'data/sessions', `${sessionId}.jsonl`), 'utf8').includes(key),
      );
      assert(
        final.requests.length >= 3 &&
          final.requests.every((request) => request.model === 'deepseek-flash'),
      );
      assert.deepEqual(app.errors, []);
      await app.page.screenshot({ path: join(root, 'live-tools.png'), fullPage: true });
      const evidence = {
        provider: 'deepseek',
        model: 'deepseek-flash',
        toolCalls: final.tools.map((tool) => ({ name: tool.name, status: tool.status })),
        requests: final.requests,
        usage: final.usage,
        reportNonempty: true,
        chartNonempty: true,
        workerNoKey: true,
        analysisAccuracyJudged: false,
      };
      writeFileSync(join(root, 'live-evidence.json'), JSON.stringify(evidence, null, 2));
      return evidence;
    } catch (error) {
      // eslint-disable-next-line preserve-caught-error -- The original cause may contain the live API key; retain only the redacted stack.
      throw new Error(String(error.stack ?? error).replaceAll(key, '[REDACTED]'));
    } finally {
      await app?.stop();
    }
  },
};
