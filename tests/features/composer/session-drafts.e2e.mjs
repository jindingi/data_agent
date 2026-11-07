import { createStoredSession } from '../../support/desktop.mjs';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { rpc } from '../../support/desktop.mjs';

export const cases = {
  async 'composer.session-drafts'({ dir }) {
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
};
