import { testBundle } from '../../../scripts/test/run-context.mjs';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { startApp, until, freePort } from '../../../scripts/test/harness.mjs';
import { modelFixture } from '../../../scripts/test/model-fixture.mjs';

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
export const cases = {
  async 'packaging.defaults'({ dir }) {
    const root = resolve(dir, 'p7-defaults'),
      fixture = await modelFixture(),
      port = await freePort();
    const app = await startApp(root, {
      packaged: true,
      automation: false,
      port,
      minimalEnvironment: true,
      testModelBaseUrl: fixture.baseUrl,
    });
    try {
      let endpoint = false;
      try {
        await fetch(`http://127.0.0.1:${port}/json/version`);
        endpoint = true;
      } catch {
        /* An unavailable CDP endpoint is expected for the normal product launch. */
      }
      assert.equal(endpoint, false);
      assert(!existsSync(join(root, 'data/automation.json')));
      assert.equal(fixture.requests.length, 0);
      const sqlite = execFileSync(
        resolve('runtime/darwin-arm64/python/bin/python3'),
        [
          '-I',
          '-B',
          '-c',
          'import sqlite3,sys,json; c=sqlite3.connect("file:"+sys.argv[1]+"?mode=ro",uri=True);print(json.dumps(c.execute("select key from app_metadata where key like \'credential.%\'").fetchall()))',
          join(root, 'data/state.sqlite'),
        ],
        { encoding: 'utf8' },
      );
      assert.deepEqual(JSON.parse(sqlite), []);
      const second = spawn(join(testBundle(), 'Contents/MacOS/Data Agent'), [], {
        env: {
          HOME: process.env.HOME,
          PATH: '/usr/bin:/bin',
          DATA_AGENT_HOME: join(root, 'data'),
          DATA_AGENT_USER_DATA: join(root, 'userData'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      second.stdout.on('data', (b) => {
        output += b;
      });
      second.stderr.on('data', (b) => {
        output += b;
      });
      const exit = new Promise((resolve) => second.once('exit', resolve));
      try {
        await until(() => second.exitCode !== null, 'second instance exit', 15000);
      } finally {
        if (second.exitCode === null) second.kill('SIGKILL');
        await exit;
      }
      assert.equal(second.exitCode, 0);
      assert(output.includes('already running'));
      assert(alive(app.child.pid));
      return {
        productionDebugClosed: true,
        noAutomaticModelRequest: true,
        noCredentialStored: true,
        secondInstanceRejected: true,
      };
    } finally {
      await app.stop();
      await fixture.close();
    }
  },
};
