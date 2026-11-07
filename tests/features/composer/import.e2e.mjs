import assert from 'node:assert/strict';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  openSync,
  ftruncateSync,
  closeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { rpc } from '../../support/desktop.mjs';

const importScenarios = new Map();

async function importScenario(dir) {
  if (importScenarios.has(dir)) return importScenarios.get(dir);
  const task = (async () => {
    const root = resolve(dir, 'p4-import');
    mkdirSync(join(root, 'a'), { recursive: true });
    mkdirSync(join(root, 'b'), { recursive: true });
    const files = [join(root, 'a/data.csv'), join(root, 'b/data.csv')];
    writeFileSync(files[0], Buffer.from([255, 0, 34, 10]));
    writeFileSync(files[1], 'not a valid table');
    const app = await startApp(join(root, 'app'), { pickFiles: files });
    try {
      const page = app.page;
      await page.getByRole('button', { name: '添加 CSV 文件', exact: true }).click();
      await until(
        () =>
          page
            .getByRole('button', { name: '移除文件 data.csv', exact: true })
            .count()
            .then((n) => n === 2),
        'two same-name attachments',
      );
      assert.equal(await page.getByTestId('session-title').getAttribute('data-session-id'), null);
      assert.equal((await rpc(page, { type: 'sessions.list' })).length, 0);
      const selected = await rpc(page, { type: 'files.inspect', paths: files });
      assert.deepEqual(new Set(selected.map((file) => file.path)), new Set(files));
      assert.deepEqual(
        selected.map((file) => file.size).sort((a, b) => a - b),
        [4, 17],
      );
      await page
        .locator(`.attachment-list > span[title="${files[0]}"]`)
        .getByRole('button')
        .click();
      assert.equal(await page.locator('.attachment-list > span').count(), 1);
      assert.equal(await page.locator('.attachment-list > span').getAttribute('title'), files[1]);
      assert.deepEqual(readFileSync(files[0]), Buffer.from([255, 0, 34, 10]));
      assert.equal(readFileSync(files[1], 'utf8'), 'not a valid table');
    } finally {
      await app.stop();
    }
    for (const mode of ['single', 'total']) {
      const source = join(root, mode);
      mkdirSync(source);
      const paths = (mode === 'single' ? [100_000_001] : [60_000_000, 60_000_000]).map(
        (size, index) => {
          const path = join(source, `${index}.csv`),
            fd = openSync(path, 'w');
          ftruncateSync(fd, size);
          closeSync(fd);
          return path;
        },
      );
      const instance = await startApp(join(root, mode + '-app'), { pickFiles: paths });
      try {
        await instance.page.getByRole('button', { name: '添加 CSV 文件', exact: true }).click();
        await instance.page
          .getByRole('alert')
          .filter({ hasText: mode === 'single' ? '单个 CSV' : 'CSV 总大小' })
          .waitFor();
        assert.equal((await rpc(instance.page, { type: 'sessions.list' })).length, 0);
        assert.equal(await instance.page.locator('.attachment-list > span').count(), 0);
      } finally {
        await instance.stop();
      }
    }
    return {
      sameBasenameDistinctPaths: true,
      metadataOnlyImport: true,
      noCopyOrParsing: true,
      removeByIdentity: true,
      singleAndAggregate100MBLimits: true,
    };
  })();
  importScenarios.set(dir, task);
  return task;
}
export const cases = {
  async 'composer.import'({ dir }) {
    return importScenario(dir);
  },
};
