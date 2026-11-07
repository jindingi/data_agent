import { createStoredSession } from '../../support/desktop.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { modelFixture } from '../../../scripts/test/model-fixture.mjs';
import { rpc, configure, submit, settled } from '../../support/desktop.mjs';

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
  async 'sessions.deletion'({ dir }) {
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
      await page.getByRole('button', { name: '添加 CSV 文件', exact: true }).click();
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
      // Shared-workspace publication inventories visible files after stopping the task.
      // A hidden manual file remains unregistered; the later manualAfter case covers ordinary
      // files added after publication. Neither may be deleted as a registered artifact.
      const manual = join(aSession.workspace, '.manual.txt');
      writeFileSync(manual, 'keep manual');
      const b = await submit(page, 'Other session keeps running.');
      await rpc(page, { type: 'sessions.rename', sessionId: b, title: 'Keep B' });
      const bRun = await running(b);
      await page.getByRole('button', { name: '打开会话 Delete A', exact: true }).click();
      await page
        .getByRole('textbox', { name: '分析需求' })
        .fill('discard this unsent draft with session A');
      await page.getByRole('button', { name: '会话操作', exact: true }).click();
      await page.getByRole('menuitem', { name: '删除会话', exact: true }).click();
      assert.equal(await page.getByRole('dialog').getByRole('checkbox').count(), 0);
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
      assert.equal(
        await page.evaluate(
          (id) => JSON.parse(localStorage.getItem('composer-drafts-v1') ?? '{}')[id],
          a,
        ),
        undefined,
      );
      assert(!existsSync(aSession.sessionFile));
      assert.equal(
        readFileSync(join(aRun.outputDirectory, 'report.md'), 'utf8'),
        '# running report\n',
      );
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
      const cSession = (await rpc(page, { type: 'sessions.open', sessionId: c })).session;
      const report = join(cSession.workspace, 'report.md');
      const manualAfter = join(cSession.workspace, 'manual-after.txt');
      writeFileSync(manualAfter, 'manual');
      writeFileSync(report, '# modified report');
      await page.getByRole('button', { name: '会话操作', exact: true }).click();
      await page.getByRole('menuitem', { name: '删除会话', exact: true }).click();
      assert.equal(await page.getByRole('dialog').getByRole('checkbox').count(), 0);
      await page
        .getByRole('dialog')
        .screenshot({ path: join(dir, 'delete-retains-workspace.png') });
      await page.getByRole('button', { name: '确认删除会话', exact: true }).click();
      await deleted(page, c);
      assert.equal(readFileSync(report, 'utf8'), '# modified report');
      assert.equal(readFileSync(manualAfter, 'utf8'), 'manual');
      await app.stop();
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      page = app.page;
      assert(!(await rpc(page, { type: 'sessions.list' })).some((s) => s.id === c || s.id === a));
      assert.equal(readFileSync(report, 'utf8'), '# modified report');
      assert.deepEqual(app.errors, []);
      return {
        runningSessionStoppedBeforeCleanup: true,
        otherSessionContinues: true,
        parentOriginalAndManualFilesPreserved: true,
        deletedSessionDoesNotReturn: true,
        workspaceAlwaysRetained: true,
      };
    } finally {
      await app?.stop();
      await fixture.close();
    }
  },
};
