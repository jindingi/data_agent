import { testBundle, testBuildDir } from '../../../scripts/test/run-context.mjs';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { startApp } from '../../../scripts/test/harness.mjs';
import { modelFixture } from '../../../scripts/test/model-fixture.mjs';
import { configure, rpc, settled, submit } from '../../support/desktop.mjs';
import { verifyRelease } from '../../../scripts/build/verify-release.mjs';

const taskTool = (name, args) => ({ tool: { name, args } });
export const cases = {
  async 'packaging.relocation'({ dir }) {
    const inventory = verifyRelease(testBundle(), testBuildDir());
    const relocated = join(resolve(dir), 'relocated', 'Data Agent.app');
    mkdirSync(join(resolve(dir), 'relocated'), { recursive: true });
    execFileSync('/usr/bin/ditto', [testBundle(), relocated]);
    const fixture = await modelFixture(),
      app = await startApp(join(dir, 'p7-relocated'), {
        packaged: true,
        packagedPath: relocated,
        minimalEnvironment: true,
        testModelBaseUrl: fixture.baseUrl,
      });
    try {
      await configure(app.page);
      const code =
        'import sys,json,pandas,numpy,seaborn,matplotlib.pyplot as plt\nplt.plot([1,2]);plt.title("中文图表");plt.savefig("chart.png");print(json.dumps({"python":sys.executable}))';
      fixture.set(
        taskTool('write', { path: 'probe.py', content: code }),
        taskTool('bash', { command: 'python3 probe.py && rg --version && fd --version' }),
        { text: 'Relocated runtime finished.' },
      );
      const id = await submit(app.page),
        final = await settled(app.page, id);
      assert.equal(final.state, 'completed');
      const tool = final.tools.find((t) => t.name === 'bash');
      assert.equal(tool.status, 'completed', tool.output);
      assert(tool.output.includes(relocated));
      assert(!tool.output.includes('Glyph '));
      const info = await rpc(app.page, { type: 'system.info' });
      assert.equal(info.packaged, true);
      assert.equal(info.architecture, 'arm64');
      assert.equal(info.abi, '150');
      assert.deepEqual(app.errors, []);
      return { inventory, relocatedRuntime: true, info };
    } finally {
      await app.stop();
      await fixture.close();
    }
  },
};
