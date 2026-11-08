import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { modelFixture } from '../../../scripts/test/model-fixture.mjs';
import {
  rpc,
  configure,
  selectSession,
  openWorkspaceFile,
  settled,
} from '../../support/desktop.mjs';

async function workbench({ dir }, packaged = false) {
  const root = join(dir, 'examples-app'),
    fixture = await modelFixture();
  let app;
  try {
    app = await startApp(root, {
      examples: true,
      offline: packaged,
      packaged,
      testModelBaseUrl: fixture.baseUrl,
    });
    const page = app.page;
    const state = await rpc(page, { type: 'examples.status' });
    assert.equal(state.error, undefined);
    assert.equal(state.sessions.length, 2);
    assert.equal((await rpc(page, { type: 'models.settings' })).configuredProviders.length, 0);
    await page.locator('.artifact-markdown').waitFor();
    assert((await page.locator('.artifact-markdown').innerText()).includes('Netflix'));
    await until(
      () =>
        page
          .locator('.artifact-markdown img')
          .evaluateAll(
            (imgs) => imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0),
          ),
      'Markdown images',
    );
    const first = state.sessions[0],
      second = state.sessions[1];
    await page.screenshot({ path: join(dir, 'examples-markdown.png') });
    await selectSession(page, second.id);
    await openWorkspaceFile(page, 'report.html');
    const report = await until(
      () =>
        app.browser
          .contexts()
          .flatMap((c) => c.pages())
          .find((p) => p.url().startsWith('data-report:')),
      'native example HTML',
    );
    await report.locator('canvas').first().waitFor();
    assert(
      (await report
        .locator('a[href="https://www.kaggle.com/datasets/shivamb/netflix-shows/data"]')
        .count()) > 0 ||
        (await report.locator('body').innerText()).includes(
          'kaggle.com/datasets/shivamb/netflix-shows',
        ),
    );
    const data = JSON.parse(await report.locator('#app-data').textContent());
    const us = String(data.meta.country_names.findIndex((pair) => pair[1] === 'United States'));
    const drama = String(data.meta.genre_names.findIndex((pair) => pair[1] === 'Dramas'));
    const count = () => report.locator('#k-total').textContent();
    assert.equal(await count(), '8,807');
    await report.locator('[data-type="movie"]').click();
    assert.equal(await count(), '6,131');
    await report.locator('#f-country').selectOption(us);
    assert.equal(await count(), '2,752');
    await report.locator('#f-genre').selectOption(drama);
    assert.equal(await count(), '835');
    await report.locator('#f-year-min').focus();
    await report.locator('#f-year-min').press('End');
    assert.equal(await count(), '18');
    await report.locator('#f-reset').click();
    assert.equal(await count(), '8,807');
    const firstRow = await report.locator('#tbody tr').first().getAttribute('data-id');
    await report.getByRole('button', { name: '下一页 ›', exact: true }).click();
    assert.notEqual(await report.locator('#tbody tr').first().getAttribute('data-id'), firstRow);
    assert.equal(await report.locator('#tbody tr').count(), 20);
    await report.locator('#f-q').fill('no-such-title-example-123');
    await until(async () => (await count()) === '0', 'empty result');
    assert(await report.locator('#empty').isVisible());
    await report.locator('#f-reset').click();
    await report.locator('#f-q').fill('Stranger Things');
    await until(async () => (await count()) === '2', 'title search');
    await report.locator('#tbody tr').first().click();
    assert.equal(await report.locator('#d-title').textContent(), 'Stranger Things');
    await page.getByRole('button', { name: '查看源码', exact: true }).click();
    await page.getByRole('button', { name: '阅读视图', exact: true }).click();
    assert.equal(await count(), '2');
    await report.locator('#f-reset').click();
    await report.screenshot({ path: join(dir, 'examples-html.png') });
    for (const [width, height] of [
      [1440, 900],
      [1100, 720],
      [940, 650],
    ]) {
      await page.setViewportSize({ width, height });
      for (const theme of ['dark', 'light']) {
        await page.evaluate((value) => {
          document.documentElement.dataset.theme = value;
        }, theme);
        await page.screenshot({ path: join(dir, `examples-host-${width}-${theme}.png`) });
        await report.screenshot({ path: join(dir, `examples-report-${width}-${theme}.png`) });
      }
    }
    await report.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await report.screenshot({ path: join(dir, 'examples-html-tail.png') });

    assert.equal(fixture.requests.length, 0, 'opening examples must not call a model');
    await page.getByRole('button', { name: '关闭结果面板', exact: true }).click();
    await page.setViewportSize({ width: 1360, height: 900 });
    // Opening, renaming and deleting these records use the ordinary session APIs.
    await rpc(page, {
      type: 'sessions.rename',
      sessionId: first.id,
      title: 'User renamed Netflix analysis',
    });
    await selectSession(page, first.id);
    await configure(page);
    const detail = await rpc(page, { type: 'sessions.agentConfig', sessionId: first.id });
    const skill = detail.binding.skills.find((s) => s.id === 'interactive-report');
    const oldReference = resolve(skill.filePath, '../references/offline-html.md');
    fixture.set(
      { tool: { name: 'read', args: { path: oldReference, limit: 2 } } },
      {
        tool: {
          name: 'write',
          args: { path: 'continued.md', content: '# Continued from the imported example' },
        },
      },
      { text: 'Continuation completed.' },
    );
    const original = readFileSync(join(root, 'data/sessions', `${first.id}.jsonl`));
    await page
      .getByRole('textbox', { name: '分析需求' })
      .fill('Continue using the local data and frozen skill.');
    await page.getByRole('button', { name: '发送分析需求', exact: true }).click();
    await until(async () => {
      const s = await rpc(page, { type: 'runtime.snapshot', sessionId: first.id });
      return (
        s?.runId &&
        s.state === 'completed' &&
        existsSync(join(root, 'data/workspace', first.id, 'continued.md'))
      );
    }, 'imported continuation');
    const actual = readFileSync(join(root, 'data/sessions', `${first.id}.jsonl`));
    assert.deepEqual(
      actual.subarray(0, original.length),
      original,
      'native history bytes only append',
    );
    assert.equal(
      (actual.toString().match(/"customType":"data_agent.resource_locations"/g) ?? []).length,
      1,
    );
    for (let i = 1; i < fixture.requests.length; i++) {
      assert.deepEqual(
        fixture.requests[i].messages.slice(0, fixture.requests[i - 1].messages.length),
        fixture.requests[i - 1].messages,
      );
      assert.deepEqual(fixture.requests[i].tools, fixture.requests[0].tools);
    }
    assert(!fixture.requests.some((r) => JSON.stringify(r).includes('内置 skill 快照已被修改')));
    await app.stop();
    app = await startApp(root, {
      examples: true,
      offline: packaged,
      packaged,
      testModelBaseUrl: fixture.baseUrl,
    });
    await selectSession(app.page, first.id);
    fixture.set({ text: 'After restart.' });
    await app.page.getByRole('textbox', { name: '分析需求' }).fill('Continue after restart.');
    await app.page.getByRole('button', { name: '发送分析需求', exact: true }).click();
    await settled(app.page, first.id);
    assert.equal(
      (
        readFileSync(join(root, 'data/sessions', `${first.id}.jsonl`), 'utf8').match(
          /"customType":"data_agent.resource_locations"/g,
        ) ?? []
      ).length,
      1,
    );
    assert.deepEqual(app.errors, []);
    return {
      withoutCredentials: true,
      realReports: true,
      ordinaryContinuation: true,
      appendOnlyHistory: true,
      packaged,
    };
  } finally {
    await app?.stop();
    await fixture.close();
  }
}
export const cases = {
  'examples.workbench': (context) => workbench(context),
  'examples.packaged': (context) => workbench(context, true),
};
