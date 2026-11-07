import { createStoredSession } from '../support/desktop.mjs';
import { openPreview } from '../support/desktop.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { startApp, until } from '../../scripts/test/harness.mjs';
import { modelFixture } from '../../scripts/test/model-fixture.mjs';
import { rpc, configure, submit, settled } from '../support/desktop.mjs';
import { runFollowup } from '../../scripts/eval/run-followup.mjs';
import { benchmark } from './p6-benchmark.mjs';
import { cases as p4 } from './p4.mjs';

async function published(page, sessionId) {
  return until(async () => {
    const value = await rpc(page, { type: 'artifacts.list', sessionId });
    return value.versions.length && value.versions.every((v) => v.state === 'published')
      ? value
      : null;
  }, 'outputs published');
}
async function deleted(page, id) {
  await until(
    async () =>
      !(await rpc(page, { type: 'sessions.list' }))
        .concat(await rpc(page, { type: 'sessions.list', archived: true }))
        .some((s) => s.id === id),
    'session deleted',
  );
}
export const cases = {
  async 'P6-DRAFTS'({ dir }) {
    const app = await startApp(join(dir, 'p6-drafts'));
    try {
      const page = app.page;
      const { id: a } = await createStoredSession(page);
      await rpc(page, { type: 'sessions.rename', sessionId: a, title: 'Draft A' });
      await page.getByRole('textbox', { name: '分析需求' }).fill('Unsaved text in A');
      const { id: b } = await createStoredSession(page);
      await rpc(page, { type: 'sessions.rename', sessionId: b, title: 'Draft B' });
      assert.equal(await page.getByRole('textbox', { name: '分析需求' }).inputValue(), '');
      await page.getByRole('textbox', { name: '分析需求' }).fill('Different text in B');
      await page.getByRole('button', { name: '打开会话 Draft A', exact: true }).click();
      await until(
        () =>
          page
            .getByRole('textbox', { name: '分析需求' })
            .inputValue()
            .then((value) => value === 'Unsaved text in A'),
        'A draft preserved',
      );
      await page.getByRole('button', { name: '打开会话 Draft B', exact: true }).click();
      await until(
        () =>
          page
            .getByRole('textbox', { name: '分析需求' })
            .inputValue()
            .then((value) => value === 'Different text in B'),
        'B draft preserved',
      );
      assert.equal(await rpc(page, { type: 'runtime.snapshot', sessionId: a }), null);
      assert.equal(await rpc(page, { type: 'runtime.snapshot', sessionId: b }), null);
      assert.deepEqual(app.errors, []);
      return {
        unsubmittedComposerTextScopedToSession: true,
        newSessionDoesNotEraseOldDraft: true,
        noImplicitModelSubmission: true,
      };
    } finally {
      await app.stop();
    }
  },
  'P6-LIVE-REGRESSION': ({ dir }) => runFollowup(join(dir, 'p6-live-regression')),
  'P6-100MB': benchmark,
  async 'P6-SETTINGS'({ dir }) {
    const root = resolve(dir, 'p6-settings'),
      fixture = await modelFixture();
    let app;
    const firstKey = 'synthetic-p6-key-first-DO-NOT-PERSIST-PLAINTEXT',
      secondKey = 'synthetic-p6-key-second-DO-NOT-PERSIST-PLAINTEXT';
    try {
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      let page = app.page;
      await configure(page, firstKey);
      await page.getByRole('button', { name: '设置', exact: true }).click();
      const initial = await rpc(page, { type: 'models.settings' }),
        flash = initial.models.find(
          (m) => m.provider === 'deepseek' && m.model === 'deepseek-flash',
        );
      assert.equal(flash.name, 'DeepSeek-V41-Flash');
      assert.equal(flash.verified, true);
      assert.deepEqual(
        await page
          .getByLabel('思考级别', { exact: true })
          .locator('option')
          .evaluateAll((nodes) => nodes.map((n) => n.value)),
        flash.thinkingLevels,
      );
      assert(!flash.thinkingLevels.includes('minimal'));
      await page.getByLabel('思考级别', { exact: true }).selectOption('off');
      await until(
        async () => (await rpc(page, { type: 'models.settings' })).thinkingLevel === 'off',
        'thinking saved',
      );
      const unsupported = await page.evaluate(() =>
        window.dataAgent.request({ type: 'models.thinking', level: 'minimal' }),
      );
      assert.equal(unsupported.ok, false);
      await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
      fixture.set({ text: 'First model run.' });
      const sessionId = await submit(page, 'First model request.');
      const first = await settled(page, sessionId);
      assert.equal(first.requests[0].model, 'deepseek-flash');
      assert.equal(first.requests[0].thinkingEnabled, false);
      assert.equal(fixture.authorizations.at(-1), `Bearer ${firstKey}`);
      await page.getByRole('button', { name: '设置', exact: true }).click();
      const alternate = initial.models.find(
        (m) => m.provider === 'deepseek' && m.model !== 'deepseek-flash',
      );
      assert(alternate);
      await page
        .getByLabel('选择模型')
        .selectOption(JSON.stringify({ provider: alternate.provider, model: alternate.model }));
      await until(
        async () =>
          (await rpc(page, { type: 'models.settings' })).selected.model === alternate.model,
        'model changed',
      );
      await page.getByRole('textbox', { name: 'API key', exact: true }).fill(secondKey);
      await page.getByRole('button', { name: '保存凭证', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'API key 已保存' }).waitFor();
      await page.getByLabel('思考级别', { exact: true }).selectOption('high');
      await page.getByRole('button', { name: '关闭对话框', exact: true }).click();
      await app.stop();
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      page = app.page;
      const restored = await rpc(page, { type: 'models.settings' });
      assert.equal(restored.selected.model, alternate.model);
      assert.equal(restored.thinkingLevel, 'high');
      assert(restored.configuredProviders.includes('deepseek'));
      assert(!JSON.stringify(restored).includes(secondKey));
      fixture.set({ text: 'Second model run.' });
      await page.getByRole('textbox', { name: '分析需求' }).fill('Use the changed model.');
      await page.getByRole('button', { name: '发送分析需求', exact: true }).click();
      const second = await until(async () => {
        const s = await rpc(page, { type: 'runtime.snapshot', sessionId });
        return s?.runId !== first.runId && s?.state === 'completed' ? s : null;
      }, 'second model run');
      assert.equal(second.requests[0].model, alternate.model);
      assert.equal(second.requests[0].thinkingEnabled, true);
      assert.equal(fixture.authorizations.at(-1), `Bearer ${secondKey}`);
      await page.getByRole('button', { name: '设置', exact: true }).click();
      await page.getByRole('button', { name: '移除凭证', exact: true }).click();
      await page.getByRole('status').filter({ hasText: '已移除凭证' }).waitFor();
      const basic = restored.models.find((m) => !m.reasoning);
      assert(basic);
      await page
        .getByLabel('选择模型')
        .selectOption(JSON.stringify({ provider: basic.provider, model: basic.model }));
      await until(
        async () => (await rpc(page, { type: 'models.settings' })).selected.model === basic.model,
        'nonreasoning model selected',
      );
      assert.equal(await page.getByLabel('思考级别', { exact: true }).count(), 0);
      await page.getByTestId('model-verification').filter({ hasText: '未验证兼容性' }).waitFor();
      await app.stop();
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      page = app.page;
      const cleared = await rpc(page, { type: 'models.settings' });
      assert(!cleared.configuredProviders.includes('deepseek'));
      assert.equal(cleared.selected.model, basic.model);
      assert.equal(cleared.thinkingLevel, 'off');
      for (const path of [
        join(root, 'data/state.sqlite'),
        join(root, 'data/state.sqlite-wal'),
        join(root, 'data/sessions', `${sessionId}.jsonl`),
        join(root, 'electron.log'),
      ])
        if (existsSync(path))
          for (const key of [firstKey, secondKey]) {
            const bytes = readFileSync(path);
            assert(!bytes.includes(key));
            assert(!bytes.includes(Buffer.from(key).toString('base64')));
          }
      assert.deepEqual(app.errors, []);
      return {
        byokSaveRotateClearRestart: true,
        persistedPlaintextKeys: false,
        selectedModelUsedOnNextRun: true,
        supportedThinkingLevelsOnly: true,
        thinkingChoiceSentAndPersisted: true,
        compatibilityLabels: true,
      };
    } finally {
      await app?.stop();
      await fixture.close();
    }
  },
  async 'P6-FILE-BOUNDARY'({ dir }) {
    const root = resolve(dir, 'p6-file-boundary'),
      fixture = await modelFixture();
    let app;
    mkdirSync(root, { recursive: true });
    const fixtures = {
      'bom.csv': Buffer.from('\ufeff日期,金额\n2026-01-01,1\n'),
      'gb18030.csv': Buffer.from([
        0xc3, 0xfb, 0xb3, 0xc6, 0x2c, 0xbd, 0xf0, 0xb6, 0xee, 0x0a, 0xbc, 0xd7, 0x2c, 0x31, 0x0a,
      ]),
      'bad-date.csv': Buffer.from('date,value\nnot-a-date,2\n'),
      'duplicate.csv': Buffer.from('id,id\n1,2\n'),
      'empty.csv': Buffer.alloc(0),
      'quotes.csv': Buffer.from('name,value\n"中文,含逗号\n换行",\n'),
      'invalid.csv': Buffer.from('name,value\n"unclosed,1\n'),
      'missing.csv': Buffer.from('x\n1\n'),
    };
    const paths = Object.keys(fixtures).map((name) => join(root, name));
    for (const [name, bytes] of Object.entries(fixtures)) writeFileSync(join(root, name), bytes);
    try {
      app = await startApp(join(root, 'app'), {
        testModelBaseUrl: fixture.baseUrl,
        pickFiles: paths,
      });
      const page = app.page;
      await configure(page);
      const { id: sessionId } = await createStoredSession(page);
      await rpc(page, { type: 'files.pick', sessionId });
      const detail = await until(async () => {
        const d = await rpc(page, { type: 'sessions.open', sessionId });
        return d.files.length === paths.length ? d : null;
      }, 'all boundary files registered');
      assert.deepEqual(new Set(detail.files.map((f) => f.path)), new Set(paths));
      for (const file of detail.files) assert.equal(file.size, fixtures[file.name].length);
      const script = `import pandas as pd\npd.read_csv(${JSON.stringify(join(root, 'invalid.csv'))})\n`;
      fixture.set(
        { tool: { name: 'read', args: { path: join(root, 'gb18030.csv') } } },
        { tool: { name: 'write', args: { path: 'parse.py', content: script } } },
        { tool: { name: 'bash', args: { command: 'python3 parse.py' } } },
        () => {
          unlinkSync(join(root, 'missing.csv'));
          return { tool: { name: 'read', args: { path: join(root, 'missing.csv') } } };
        },
        { text: '数据读取遇到编码、CSV 格式和缺失文件错误；请检查来源后继续。' },
      );
      await page
        .getByRole('textbox', { name: '分析需求' })
        .fill('Read these files and explain errors.');
      await page.getByRole('button', { name: '发送分析需求', exact: true }).click();
      const final = await settled(page, sessionId);
      assert.equal(final.state, 'completed');
      const failed = final.tools.filter((t) => t.status === 'failed');
      assert.equal(failed.length, 3);
      assert(failed.some((t) => t.output.includes('UTF-8')));
      assert(failed.some((t) => t.output.includes('ParserError')));
      assert(failed.some((t) => /ENOENT|不存在|无法访问/.test(t.output)));
      for (const tool of failed) {
        const card = page.locator(`[data-tool-id="${tool.id}"]`);
        await card.locator('summary').click();
        await card.getByText('执行失败', { exact: true }).waitFor();
        assert((await card.innerText()).includes(tool.output.slice(0, 35)));
      }
      await page
        .getByText('数据读取遇到编码、CSV 格式和缺失文件错误；请检查来源后继续。', { exact: true })
        .waitFor();
      assert(
        (await rpc(page, { type: 'sessions.open', sessionId })).files.find(
          (f) => f.name === 'missing.csv',
        ).missing,
      );
      for (const [name, bytes] of Object.entries(fixtures))
        if (name !== 'missing.csv') assert.deepEqual(readFileSync(join(root, name)), bytes);
      assert.deepEqual(app.errors, []);
    } finally {
      await app?.stop();
      await fixture.close();
    }
    const sizeBoundary = await p4['P4-IMPORT']({ dir });
    return {
      boundaryFormatsRegisteredWithoutParsing: true,
      realToolErrorsVisible: true,
      agentContinuesWithExplanation: true,
      sourceMissingVisible: true,
      originalsUnmodified: true,
      sizeBoundary,
    };
  },
  async 'P6-RENDER'({ dir }) {
    const root = resolve(dir, 'p6-render'),
      fixture = await modelFixture();
    let app;
    mkdirSync(root, { recursive: true });
    const secret = join(root, 'private-text.txt');
    writeFileSync(secret, 'PRIVATE_FILE_MUST_NOT_RENDER');
    const hostile = `# Safe report heading\n\n<script>window.__p6Executed=true</script>\n\n<img src="x" onerror="window.__p6Executed=true">\n\n![remote](https://p6-untrusted.invalid/remote.png)\n\n![local](file://${secret})\n\n[bad](javascript:window.__p6Executed=true)\n\n<iframe src="file://${secret}"></iframe>\n\n![registered chart](chart.png)\n`;
    const longText =
      'LONG_MESSAGE_BEGIN\n\n' +
      hostile +
      '一段可分页的长消息。中文与 emoji 🌱 均保留。\n\n'.repeat(3200) +
      '\nLONG_MESSAGE_END';
    try {
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      let page = app.page;
      await configure(page);
      const remoteRequests = [];
      page.on('request', (request) => {
        if (request.url().includes('p6-untrusted.invalid') || request.url() === `file://${secret}`)
          remoteRequests.push(request.url());
      });
      await page.evaluate(() => {
        window.__p6Executed = false;
      });
      const ls = { tool: { name: 'ls', args: { path: '.' } } };
      fixture.set(
        {
          tool: {
            name: 'write',
            args: {
              path: 'chart.py',
              content:
                'from PIL import Image\nImage.new("RGB", (32,32), (23,160,95)).save("chart.png")\n',
            },
          },
        },
        { tool: { name: 'bash', args: { command: 'python3 chart.py' } } },
        { tool: { name: 'write', args: { path: 'report.md', content: hostile } } },
        ...Array.from({ length: 8 }, () => ls),
        { text: longText },
      );
      const sessionId = await submit(page, 'FIRST_USER_MESSAGE_PAGINATION');
      const first = await settled(page, sessionId);
      assert.equal(first.state, 'completed');
      await published(page, sessionId);
      await openPreview(page, '预览');
      await page
        .locator('.artifact-markdown')
        .getByRole('heading', { name: 'Safe report heading' })
        .waitFor();
      const image = page
        .locator('.artifact-markdown')
        .getByRole('img', { name: 'registered chart', exact: true });
      await until(
        () => image.evaluate((element) => element.complete && element.naturalWidth === 32),
        'registered PNG decoded',
      );
      assert.equal(
        await page
          .locator(
            '.artifact-markdown script,.artifact-markdown iframe,.artifact-markdown object,.artifact-markdown [onerror]',
          )
          .count(),
        0,
      );
      await page.getByRole('button', { name: '展开结果面板', exact: true }).click();
      assert(
        (await page.getByRole('complementary', { name: '结果面板' }).boundingBox()).width > 500,
      );
      await page.getByRole('button', { name: '缩小结果面板', exact: true }).click();
      const message = page
        .locator('.history-message.assistant')
        .filter({ has: page.locator('.markdown-body', { hasText: 'LONG_MESSAGE_BEGIN' }) });
      assert.equal(await message.locator('.markdown-body .paged-text').count(), 0);
      await page
        .locator('.history-message.assistant .markdown-body')
        .filter({ hasText: 'LONG_MESSAGE_END' })
        .waitFor();
      assert(
        first.messages.some((m) =>
          m.blocks.some((b) => b.type === 'text' && b.text.endsWith('LONG_MESSAGE_END')),
        ),
      );
      fixture.set(...Array.from({ length: 8 }, () => ls), { text: 'SECOND_RUN_END' });
      await page.getByRole('textbox', { name: '分析需求' }).fill('Continue this conversation.');
      await page.getByRole('button', { name: '发送分析需求', exact: true }).click();
      await until(async () => {
        const value = await rpc(page, { type: 'runtime.snapshot', sessionId });
        return value?.runId !== first.runId && value?.state === 'completed';
      }, 'second run ended');
      assert.equal(await page.locator('.history-pagination').count(), 0);
      const chat = page.locator('.history-list');
      await chat.hover();
      await page.mouse.wheel(0, -1000000);
      const load = page.getByRole('button', { name: '加载更早消息', exact: true });
      while (await load.isVisible()) {
        await load.click();
        await chat.hover();
        await page.mouse.wheel(0, -1000000);
      }
      await page.getByText('FIRST_USER_MESSAGE_PAGINATION', { exact: true }).waitFor();
      await page.getByRole('button', { name: '回到最新消息', exact: true }).click();
      await page.getByText('SECOND_RUN_END', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.__p6Executed), false);
      assert.deepEqual(remoteRequests, []);
      assert(!(await page.locator('body').innerText()).includes('PRIVATE_FILE_MUST_NOT_RENDER'));
      assert.deepEqual(app.errors, []);
      await app.stop();
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      page = app.page;
      await page.getByText('SECOND_RUN_END', { exact: true }).waitFor();
      const restored = await rpc(page, { type: 'runtime.snapshot', sessionId });
      assert(
        restored.messages.some((m) =>
          m.blocks.some((b) => b.type === 'text' && b.text.endsWith('LONG_MESSAGE_END')),
        ),
      );
      assert((await page.locator('.history-message').count()) <= 20);
      assert.deepEqual(app.errors, []);
      return {
        scriptExecution: false,
        remoteOrArbitraryFileRequests: remoteRequests.length,
        pngDecoded: true,
        expandedReport: true,
        longTextEndAccessible: true,
        conversationPagination: true,
        fullLongMessageRestored: true,
      };
    } finally {
      await app?.stop();
      await fixture.close();
    }
  },
  async 'P6-DELETE'({ dir }) {
    const root = resolve(dir, 'p6-delete'),
      fixture = await modelFixture();
    let app;
    const outside = join(root, 'external-parent'),
      original = join(root, 'original.csv');
    mkdirSync(outside, { recursive: true });
    writeFileSync(original, 'name,value\nA,1\n');
    try {
      app = await startApp(root, {
        testModelBaseUrl: fixture.baseUrl,
        pickFiles: [original],
        pickDirectory: outside,
      });
      let page = app.page;
      await configure(page);
      const loop = {
        tool: {
          name: 'bash',
          args: {
            command:
              "printf '# running report\\n' > report.md; while [ ! -f release ]; do printf tick >> heartbeat.txt; sleep 0.1; done",
          },
        },
      };
      fixture.set(loop, loop);
      const { id: a } = await createStoredSession(page, true);
      await rpc(page, { type: 'files.pick', sessionId: a });
      await until(
        async () => (await rpc(page, { type: 'sessions.open', sessionId: a })).files.length === 1,
        'CSV registered',
      );
      await rpc(page, { type: 'sessions.rename', sessionId: a, title: 'Delete A' });
      await page.getByRole('textbox', { name: '分析需求' }).fill('Keep working until stopped.');
      await page.getByRole('button', { name: '发送分析需求', exact: true }).click();
      const running = async (id) =>
        until(async () => {
          const s = await rpc(page, { type: 'runtime.snapshot', sessionId: id });
          return s?.outputDirectory && existsSync(join(s.outputDirectory, 'heartbeat.txt'))
            ? s
            : null;
        }, 'actual worker running');
      const aRun = await running(a),
        aHost = await rpc(page, { type: 'automation.control', action: 'host_pid', sessionId: a });
      const aSession = (await rpc(page, { type: 'sessions.open', sessionId: a })).session;
      const manual = join(aSession.workspace, 'manual.txt');
      writeFileSync(manual, 'keep manual');
      const b = await submit(page, 'Other session keeps running.');
      await rpc(page, { type: 'sessions.rename', sessionId: b, title: 'Keep B' });
      const bRun = await running(b);
      await page.getByRole('button', { name: '打开会话 Delete A', exact: true }).click();
      await page.getByRole('button', { name: '会话操作', exact: true }).click();
      await page.getByRole('menuitem', { name: '删除会话', exact: true }).click();
      await page.getByRole('checkbox').check();
      await page.getByRole('button', { name: '确认删除会话', exact: true }).click();
      await deleted(page, a);
      await until(
        () =>
          page
            .getByRole('dialog')
            .count()
            .then((n) => n === 0),
        'delete dialog closed',
      );
      assert(!existsSync(aSession.sessionFile));
      assert(!existsSync(join(aRun.outputDirectory, 'report.md')));
      assert.equal(readFileSync(manual, 'utf8'), 'keep manual');
      assert.equal(readFileSync(original, 'utf8'), 'name,value\nA,1\n');
      assert(existsSync(outside));
      assert.throws(() => process.kill(aHost, 0));
      const size = statSync(join(bRun.outputDirectory, 'heartbeat.txt')).size;
      await until(
        () => statSync(join(bRun.outputDirectory, 'heartbeat.txt')).size > size,
        'other worker continues',
      );
      assert.equal((await rpc(page, { type: 'runtime.snapshot', sessionId: b })).state, 'running');
      await rpc(page, { type: 'runtime.cancel', sessionId: b });
      await settled(page, b);
      fixture.set(
        { tool: { name: 'write', args: { path: 'report.md', content: '# original report' } } },
        { text: 'File delivered.' },
      );
      const c = await submit(page, 'Make a report to exercise cleanup retry.');
      await settled(page, c);
      const listing = await published(page, c);
      const report = listing.files.find((f) => f.relativePath === 'report.md');
      assert(report);
      const manualAfter = join(listing.versions[0].directory, 'manual-after.txt');
      writeFileSync(manualAfter, 'never registered');
      writeFileSync(report.path, '# manually modified');
      await page.getByRole('button', { name: '会话操作', exact: true }).click();
      await page.getByRole('menuitem', { name: '删除会话', exact: true }).click();
      await page.getByRole('checkbox').check();
      await page.getByRole('button', { name: '确认删除会话', exact: true }).click();
      await page.getByRole('button', { name: '继续清理', exact: true }).waitFor();
      const pending = await rpc(page, { type: 'sessions.deletePreview', sessionId: c });
      assert.equal(pending.remaining.length, 1);
      assert.equal(pending.remaining[0].path, report.path);
      await app.stop();
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      page = app.page;
      await until(
        () =>
          page
            .getByTestId('session-title')
            .getAttribute('data-session-id')
            .then((id) => id === c),
        'deleting session restored',
      );
      await page.getByRole('button', { name: '会话操作', exact: true }).click();
      await page.getByRole('menuitem', { name: '删除会话', exact: true }).click();
      await page.getByRole('button', { name: '继续清理', exact: true }).waitFor();
      assert.equal(await page.getByRole('checkbox').isChecked(), true);
      assert.equal(await page.getByRole('checkbox').isDisabled(), true);
      writeFileSync(report.path, '# original report');
      await page.getByRole('button', { name: '继续清理', exact: true }).click();
      await deleted(page, c);
      assert.equal(readFileSync(manualAfter, 'utf8'), 'never registered');
      assert(!existsSync(report.path));
      fixture.set(
        { tool: { name: 'write', args: { path: 'report.md', content: '# retained file' } } },
        { text: 'File delivered.' },
      );
      const d = await submit(page, 'Keep the files when removing this conversation.');
      await settled(page, d);
      const keep = (await published(page, d)).files.find((f) => f.relativePath === 'report.md');
      await page.getByRole('button', { name: '会话操作', exact: true }).click();
      await page.getByRole('menuitem', { name: '删除会话', exact: true }).click();
      assert.equal(await page.getByRole('checkbox').isChecked(), false);
      await page.getByRole('button', { name: '确认删除会话', exact: true }).click();
      await deleted(page, d);
      assert.equal(readFileSync(keep.path, 'utf8'), '# retained file');
      await until(
        () =>
          page
            .getByRole('dialog')
            .count()
            .then((n) => n === 0),
        'final deletion closed',
      );
      assert.equal(await page.getByRole('alert').count(), 0);
      assert.deepEqual(app.errors, []);
      return {
        runningSessionStoppedBeforeCleanup: true,
        otherSessionContinues: true,
        parentOriginalAndManualFilesPreserved: true,
        partialFailureRecoveredAfterRestart: true,
        explicitKeepArtifactsHonored: true,
      };
    } finally {
      await app?.stop();
      await fixture.close();
    }
  },
  async 'P6-LOG-UI'({ dir }) {
    const root = resolve(dir, 'p6-log-ui'),
      fixture = await modelFixture();
    let app;
    try {
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      const page = app.page;
      await configure(page);
      fixture.set(
        {
          tool: {
            name: 'bash',
            args: {
              command: 'python3 -c \'print("日志正文" * 20000); print("LOG_END_SENTINEL")\'',
            },
          },
        },
        { text: 'Large tool output delivered.' },
      );
      const sessionId = await submit(page, 'Produce a large tool log.');
      const final = await settled(page, sessionId);
      const tool = final.tools.find((t) => t.name === 'bash');
      assert(tool);
      assert(tool.output.includes('截断'));
      const card = page.locator(`[data-tool-id="${tool.id}"]`);
      await card.locator('summary').click();
      await card.getByRole('button', { name: '查看完整日志', exact: true }).click();
      const content = page.getByTestId('full-tool-log');
      await content.waitFor();
      let text = await content.innerText(),
        pages = 1;
      while (await page.getByRole('button', { name: '下一页日志', exact: true }).isEnabled()) {
        const before = await content.innerText();
        await page.getByRole('button', { name: '下一页日志', exact: true }).click();
        await until(
          () => page.getByRole('button', { name: '刷新日志', exact: true }).isEnabled(),
          'log loaded',
        );
        const next = await content.innerText();
        text += next;
        pages++;
        assert(pages < 20);
        assert(before || next);
      }
      assert(text.includes('LOG_END_SENTINEL'));
      assert(pages > 3);
      assert(!text.includes('\ufffd'));
      await page.getByRole('button', { name: '上一页日志', exact: true }).click();
      await until(
        () => page.getByRole('button', { name: '下一页日志', exact: true }).isEnabled(),
        'previous page loaded',
      );
      const records = await rpc(page, { type: 'logs.list', sessionId, toolCallId: tool.id });
      assert.equal(records.length, 1);
      assert(records[0].peakRss > 0);
      assert.deepEqual(app.errors, []);
      return {
        actualLogPages: pages,
        endBeyondStreamTruncationVisible: true,
        utf8Preserved: true,
        peakRss: records[0].peakRss,
      };
    } finally {
      await app?.stop();
      await fixture.close();
    }
  },
};
