import { openExecutionProcesses } from '../../support/desktop.mjs';
import { createStoredSession } from '../../support/desktop.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { startApp } from '../../../scripts/test/harness.mjs';
import { modelFixture } from '../../../scripts/test/model-fixture.mjs';
import { rpc, configure, settled } from '../../support/desktop.mjs';
import { cases as imports } from './import.e2e.mjs';

export const cases = {
  async 'composer.file-boundaries'({ dir }) {
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
      const selected = await rpc(page, { type: 'files.choose' });
      assert.deepEqual(new Set(selected.map((f) => f.path)), new Set(paths));
      for (const file of selected) assert.equal(file.size, fixtures[file.name].length);
      await page.getByRole('button', { name: '添加 CSV 文件', exact: true }).click();
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
        await openExecutionProcesses(page);
        await card.locator('summary').click();
        await card.getByText('执行失败', { exact: true }).waitFor();
        assert((await card.innerText()).includes(tool.output.slice(0, 35)));
      }
      await page
        .getByText('数据读取遇到编码、CSV 格式和缺失文件错误；请检查来源后继续。', { exact: true })
        .waitFor();
      for (const [name, bytes] of Object.entries(fixtures))
        if (name !== 'missing.csv') assert.deepEqual(readFileSync(join(root, name)), bytes);
      assert.deepEqual(app.errors, []);
    } finally {
      await app?.stop();
      await fixture.close();
    }
    const sizeBoundary = await imports['composer.import']({ dir });
    return {
      boundaryFormatsRegisteredWithoutParsing: true,
      realToolErrorsVisible: true,
      agentContinuesWithExplanation: true,
      sourceMissingVisible: true,
      originalsUnmodified: true,
      sizeBoundary,
    };
  },
};
