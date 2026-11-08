import assert from 'node:assert/strict';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { modelFixture } from '../../scripts/test/model-fixture.mjs';

test('scripted HTTP requests retain UTF-8 characters split across network chunks', async () => {
  const fixture = await modelFixture();
  fixture.set({ text: 'Done' });
  try {
    const completed = new Promise((resolve, reject) => {
      const req = request(`${fixture.baseUrl}/chat/completions`, { method: 'POST' }, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.flushHeaders();
      req.write(
        Buffer.concat([
          Buffer.from('{"model":"synthetic","messages":[{"role":"tool","content":"'),
          Buffer.from([0xe4]),
        ]),
      );
      void delay(20).then(() =>
        req.end(Buffer.concat([Buffer.from([0xb8, 0xad]), Buffer.from('"}]}')])),
      );
    });
    await completed;
    assert.equal(fixture.requests[0].messages[0].content, '中');
  } finally {
    await fixture.close();
  }
});
