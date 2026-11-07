import { createStoredSession, selectSession, rpc, openPreview } from '../../support/desktop.mjs';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { startApp } from '../../../scripts/test/harness.mjs';

export const cases = {
  async 'composer.input-references'({ dir }) {
    const inputDir = join(dir, '原文件');
    mkdirSync(inputDir, { recursive: true });
    const file = join(inputDir, '数据.csv');
    const raw = Buffer.from([0xff, 0x00, 0x22, 0x0a]);
    writeFileSync(file, raw);
    const root = join(dir, 'file-ref');
    let app = await startApp(root, { pickFiles: [file] });
    try {
      const created = await createStoredSession(app.page);
      await rpc(app.page, { type: 'files.pick', sessionId: created.id });
      assert.deepEqual(readFileSync(file), raw);
      assert.deepEqual(readdirSync(created.workspace), []);
      await openPreview(app.page, '文件');
      await app.page.getByText(file, { exact: true }).waitFor();
      await app.stop();
      unlinkSync(file);
      app = await startApp(root);
      await selectSession(app.page, created.id);
      await openPreview(app.page, '文件');
      await app.page.getByText('原文件不可用', { exact: true }).waitFor();
      assert.equal(existsSync(file), false);
      assert.deepEqual(readdirSync(created.workspace), []);
      const detail = await app.page.evaluate(
        (id) => window.dataAgent.request({ type: 'sessions.open', sessionId: id }),
        created.id,
      );
      assert.equal(detail.value.files[0].path, file);
      assert.equal(detail.value.files[0].missing, true);
      return { originalPathOnly: true, noCSVParsing: true, missingFileReported: true };
    } finally {
      await app.stop();
    }
  },
};
