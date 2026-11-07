import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startApp, freePort } from '../../../scripts/test/harness.mjs';

async function info(page) {
  const result = await page.evaluate(() => window.dataAgent.request({ type: 'system.info' }));
  assert.equal(result.ok, true);
  return result.value;
}
export const cases = {
  async 'application.isolation'({ dir }) {
    const a = await startApp(join(dir, 'instance-a'));
    let b, normal;
    try {
      b = await startApp(join(dir, 'instance-b'));
      const ai = await info(a.page),
        bi = await info(b.page);
      assert.notEqual(ai.dataHome, bi.dataHome);
      for (const instance of [a, b]) {
        const meta = JSON.parse(readFileSync(join(instance.root, 'data/automation.json'), 'utf8'));
        assert.equal(meta.paths.home, join(instance.root, 'data'));
        assert.equal(meta.userData, join(instance.root, 'userData'));
        assert.notEqual(meta.userData, meta.paths.home);
        assert.ok(existsSync(join(meta.paths.home, 'state.sqlite')));
      }
      const normalPort = await freePort();
      normal = await startApp(join(dir, 'normal'), { automation: false, port: normalPort });
      let connected = false;
      try {
        await fetch(`http://127.0.0.1:${normalPort}/json/version`);
        connected = true;
      } catch {
        /* Must not listen. */
      }
      assert.equal(connected, false);
      assert.equal(existsSync(join(normal.root, 'data/automation.json')), false);
      return { twoIsolatedInstances: true, productionDebugClosed: true };
    } finally {
      await a.stop();
      await b?.stop();
      await normal?.stop();
    }
  },
};
