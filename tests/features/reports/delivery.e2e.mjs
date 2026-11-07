import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { modelFixture } from '../../../scripts/test/model-fixture.mjs';
import { configure, rpc, submit, settled, openWorkspaceFile } from '../../support/desktop.mjs';
import { reportFixture } from '../../support/report-fixture.mjs';
const require = createRequire(import.meta.url);
export const cases = {
  async 'reports.delivery'({ dir }) {
    const fixture = await modelFixture();
    const app = await startApp(join(dir, 'html-delivery'), { testModelBaseUrl: fixture.baseUrl });
    try {
      await configure(app.page);
      const initial = (await rpc(app.page, { type: 'agentConfig.get' })).current;
      assert.deepEqual(initial.config.enabledSkills, ['data-analysis', 'interactive-report']);
      await app.page.getByRole('button', { name: '设置', exact: true }).click();
      await app.page.getByRole('tab', { name: 'Agent 配置', exact: true }).click();
      await app.page.getByRole('switch', { name: '启用 data-analysis', exact: true }).uncheck();
      assert(
        await app.page
          .getByRole('switch', { name: '启用 interactive-report', exact: true })
          .isChecked(),
      );
      await app.page.getByRole('button', { name: '保存配置', exact: true }).click();
      await until(
        async () => (await rpc(app.page, { type: 'agentConfig.get' })).current.revision === 2,
        'independent skill selection',
      );
      await app.page.getByRole('button', { name: '关闭对话框', exact: true }).click();
      const binding = (await rpc(app.page, { type: 'agentConfig.get' })).current;
      assert.deepEqual(binding.config.enabledSkills, ['interactive-report']);
      const skill = binding.skills[0];
      const library = readFileSync(require.resolve('echarts/dist/echarts.min.js'), 'utf8');
      const template = reportFixture('comparison').replace(library, '/* ECHARTS_LIBRARY */');
      const script = String.raw`from pathlib import Path
import html,json
base=Path(${JSON.stringify(dirname(skill.filePath))})
source=Path('source.html').read_text()
source=source.replace('/* ECHARTS_LIBRARY */',(base/'vendor/echarts.min.js').read_text())
data=json.dumps({'label':'</script><img src=x onerror=alert(1)>','id':'9007199254740993'},ensure_ascii=False,allow_nan=False).replace('<', '\\u003c')
source+='<script type="application/json" id="data">'+data+'</script>'
source+='<template>'+html.escape((base/'vendor/LICENSE').read_text()+(base/'vendor/NOTICE').read_text())+'</template>'
Path('report.html').write_text(source)
print('assembled',Path('report.html').stat().st_size)
`;
      fixture.set(
        { tool: { name: 'read', args: { path: skill.filePath } } },
        {
          tool: {
            name: 'read',
            args: { path: join(dirname(skill.filePath), 'references/offline-html.md') },
          },
        },
        { tool: { name: 'write', args: { path: 'source.html', content: template } } },
        { tool: { name: 'write', args: { path: 'assemble.py', content: script } } },
        { tool: { name: 'bash', args: { command: 'python3 assemble.py' } } },
        { text: 'Interactive HTML delivered.' },
      );
      const sessionId = await submit(app.page, '生成交互 HTML，布局按本次比较意图决定。');
      assert.equal((await settled(app.page, sessionId)).state, 'completed');
      const results = fixture.requests.flatMap((r) => r.messages.filter((m) => m.role === 'tool'));
      assert(results.some((m) => String(m.content).includes('# Interactive reports')));
      assert(!results.some((m) => String(m.content).includes('ENOENT')));
      assert(!JSON.stringify(fixture.requests).includes(library.slice(0, 300)));
      for (let i = 1; i < fixture.requests.length; i++) {
        const previous = fixture.requests[i - 1];
        assert.deepEqual(
          fixture.requests[i].messages.slice(0, previous.messages.length),
          previous.messages,
        );
        assert.deepEqual(fixture.requests[i].tools, previous.tools);
      }
      await openWorkspaceFile(app.page, 'report.html');
      const report = await until(
        () =>
          app.browser
            .contexts()
            .flatMap((c) => c.pages())
            .find((p) => p.url().startsWith('data-report:')),
        'generated report',
      );
      await report.getByLabel('地区').selectOption('east');
      assert.equal(await report.locator('#total').textContent(), '30');
      assert.equal(await report.locator('img').count(), 0);
      assert.equal(
        await report.evaluate(() => JSON.parse(document.getElementById('data').textContent).id),
        '9007199254740993',
      );
      assert.deepEqual(app.errors, []);
      return {
        realGenericTools: true,
        independentSkill: true,
        safeDataEmbedding: true,
        prefixesStable: true,
      };
    } finally {
      await app.stop();
      await fixture.close();
    }
  },
};
