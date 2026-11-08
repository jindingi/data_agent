import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { until } from '../../../scripts/test/harness.mjs';
import { runContext } from '../../../scripts/test/run-context.mjs';

export const cases = {
  async 'application.artifact-cli'({ dir }) {
    const artifactRoot = join(runContext().root, 'cli-build');
    const built = execFileSync('pnpm', ['build', '--run-root', artifactRoot], { encoding: 'utf8' });
    const context = JSON.parse(built.split('\n').find((line) => line.startsWith('{')));
    assert.equal(context.status, 'ready');
    assert.equal(context.root, artifactRoot);
    const child = spawn(
      process.execPath,
      [resolve('scripts/test/dev-cdp.mjs'), '--run-root', artifactRoot, '--no-build'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '',
      exited = false;
    const exit = new Promise((done) =>
      child.once('exit', (code) => {
        exited = true;
        done(code);
      }),
    );
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    try {
      const ready = await until(
        () => {
          if (exited) throw new Error(`CDP CLI exited: ${output}`);
          return output
            .split('\n')
            .slice(0, -1)
            .filter((line) => line.startsWith('{'))
            .map((line) => JSON.parse(line))
            .find((value) => value.status === 'ready');
        },
        'isolated CDP CLI',
        45_000,
      );
      assert.equal(ready.artifacts.root, artifactRoot);
      const meta = JSON.parse(
        readFileSync(join(ready.dataDirectory, 'data/automation.json'), 'utf8'),
      );
      assert.equal(meta.background, true);
      assert.equal(meta.windowVisible, false);
      assert.equal(meta.windowFocused, false);
      const version = await (await fetch(`${ready.endpoint}/json/version`)).json();
      assert(version.webSocketDebuggerUrl);
      return { cliBuild: context.root, cliCdp: true, hiddenWindow: true, pid: ready.pid };
    } finally {
      child.kill('SIGTERM');
      await until(() => exited, 'CDP CLI cleanup', 15_000).catch(() => child.kill('SIGKILL'));
      await exit;
      writeFileSync(join(dir, 'artifact-cli.log'), output);
    }
  },
};
