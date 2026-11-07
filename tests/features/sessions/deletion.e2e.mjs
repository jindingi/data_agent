import { createStoredSession } from '../../support/desktop.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { modelFixture } from '../../../scripts/test/model-fixture.mjs';
import { rpc, configure, submit, settled } from '../../support/desktop.mjs';

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
      assert.equal(
        await page.evaluate(
          (id) => JSON.parse(localStorage.getItem('composer-drafts-v1') ?? '{}')[id],
          a,
        ),
        undefined,
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
};
