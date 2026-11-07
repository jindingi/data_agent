import assert from 'node:assert/strict';
import { join } from 'node:path';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { modelFixture } from '../../../scripts/test/model-fixture.mjs';
import { configure, submit, settled, rpc } from '../../support/desktop.mjs';

const gate = () => {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

const usage = (input, cached, output, reasoning = 0) => ({
  prompt_tokens: input + cached,
  completion_tokens: output,
  total_tokens: input + cached + output,
  prompt_cache_hit_tokens: cached,
  completion_tokens_details: { reasoning_tokens: reasoning },
});
export const cases = {
  async 'usage.concurrent-crash-recovery'({ dir }) {
    const fixture = await modelFixture(),
      pending = gate();
    const root = join(dir, 'usage-recovery');
    let app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
    try {
      let page = app.page;
      await configure(page);
      fixture.set(
        { tool: { name: 'ls', args: { path: '.' } }, usage: usage(10, 20, 30) },
        async () => {
          await pending.promise;
          return { text: 'not delivered' };
        },
        { text: 'CONCURRENT_USAGE', usage: usage(100, 200, 300) },
      );
      const a = await submit(page, 'Interrupted session A');
      await until(() => fixture.requests.length === 2, 'A second request in flight');
      const b = await submit(page, 'Concurrent session B');
      const bFinal = await settled(page, b);
      assert.equal(bFinal.turnUsage[0].totalTokens, 600);
      const pid = await rpc(page, { type: 'automation.control', action: 'host_pid', sessionId: a });
      process.kill(pid, 'SIGKILL');
      const aFinal = await settled(page, a);
      assert.equal(aFinal.state, 'interrupted');
      assert.equal(aFinal.turnUsage[0].totalTokens, 60);
      assert.equal(aFinal.turnUsage[0].complete, false);
      assert.equal(aFinal.turnUsage[0].status, 'interrupted');
      pending.release();
      assert.deepEqual(
        (await rpc(page, { type: 'runtime.snapshot', sessionId: b })).turnUsage,
        bFinal.turnUsage,
      );
      await app.stop();
      app = await startApp(root, { testModelBaseUrl: fixture.baseUrl });
      page = app.page;
      const restoredA = await rpc(page, { type: 'runtime.snapshot', sessionId: a });
      assert.deepEqual(restoredA.turnUsage, aFinal.turnUsage);
      assert.deepEqual(
        (await rpc(page, { type: 'runtime.snapshot', sessionId: b })).turnUsage,
        bFinal.turnUsage,
      );
      assert.equal(fixture.requests.length, 3, 'restart does not repeat model requests');
      assert.deepEqual(app.errors, []);
      return { concurrentIsolation: true, hostCrash: true, restart: true, noReplay: true };
    } finally {
      pending.release();
      await app.stop();
      await fixture.close();
    }
  },
};
