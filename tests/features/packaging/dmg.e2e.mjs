import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmdirSync, readlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { runContext } from '../../../scripts/test/run-context.mjs';
import { diskImagePath, inspectDiskImage } from '../../../scripts/build/dmg.mjs';
import { verifyRelease } from '../../../scripts/build/verify-release.mjs';
import { rpc, selectSession, openWorkspaceFile } from '../../support/desktop.mjs';

export const cases = {
  async 'packaging.dmg'({ dir }) {
    const context = runContext(),
      image = diskImagePath(context);
    // Native volume mounts need a local system filesystem, even when the repo is on an external disk.
    const mount = mkdtempSync(join(tmpdir(), 'data-agent-dmg-')),
      installed = join(dir, 'dmg-installed', 'Data Agent.app');
    mkdirSync(join(dir, 'dmg-installed'));
    let mounted = false,
      app;
    try {
      execFileSync('/usr/bin/hdiutil', ['verify', image], { stdio: 'pipe' });
      execFileSync(
        '/usr/bin/hdiutil',
        ['attach', image, '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount],
        { stdio: 'pipe' },
      );
      mounted = true;
      assert.equal(readlinkSync(join(mount, 'Applications')), '/Applications');
      verifyRelease(join(mount, 'Data Agent.app'), context.buildDir, context.sourceRoot);
      execFileSync('/usr/bin/ditto', [join(mount, 'Data Agent.app'), installed]);
      execFileSync('/usr/bin/hdiutil', ['detach', mount], { stdio: 'pipe' });
      mounted = false;
      app = await startApp(join(dir, 'dmg-app'), {
        artifacts: context,
        packaged: true,
        packagedPath: installed,
        examples: true,
        minimalEnvironment: true,
      });
      const state = await rpc(app.page, { type: 'examples.status' });
      assert.equal(state.error, undefined);
      assert.equal(state.sessions.length, 2);
      assert.equal(
        (await rpc(app.page, { type: 'models.settings' })).configuredProviders.length,
        0,
      );
      await app.page.locator('.artifact-markdown').waitFor();
      await until(
        () =>
          app.page
            .locator('.artifact-markdown img')
            .evaluateAll(
              (imgs) =>
                imgs.length > 0 && imgs.every((img) => img.complete && img.naturalWidth > 0),
            ),
        'installed Markdown images',
      );
      await selectSession(app.page, state.sessions[1].id);
      await openWorkspaceFile(app.page, 'report.html');
      const report = await until(
        () =>
          app.browser
            .contexts()
            .flatMap((c) => c.pages())
            .find((p) => p.url().startsWith('data-report:')),
        'installed HTML report',
      );
      await report.locator('canvas').first().waitFor();
      assert.equal(await report.locator('#k-total').textContent(), '8,807');
      await report.locator('[data-type="movie"]').click();
      assert.equal(await report.locator('#k-total').textContent(), '6,131');
      const info = await rpc(app.page, { type: 'system.info' });
      assert(info.packaged && info.sqliteVersion);
      assert.equal(info.architecture, 'arm64');
      assert(existsSync(join(installed, 'Contents/Resources/runtime/python/bin/python3.12')));
      assert.deepEqual(app.errors, []);
      return {
        image: inspectDiskImage(context),
        mountedAndCopied: true,
        launchedAfterEject: true,
        examplesWithoutKey: true,
      };
    } finally {
      await app?.stop();
      if (mounted) execFileSync('/usr/bin/hdiutil', ['detach', mount], { stdio: 'pipe' });
      rmdirSync(mount);
    }
  },
};
