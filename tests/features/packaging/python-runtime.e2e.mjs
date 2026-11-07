import { testAppDir, testBundle } from '../../../scripts/test/run-context.mjs';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startApp } from '../../../scripts/test/harness.mjs';
import { verifyRuntime } from '../../../scripts/build/verify-runtime.mjs';
import { configure, submit, settled } from '../../support/desktop.mjs';
import { modelFixture } from '../../../scripts/test/model-fixture.mjs';

export const cases = {
  async 'packaging.python-runtime'({ dir }) {
    const evidence = [];
    for (const packaged of [false, true]) {
      const root = resolve(dir, packaged ? 'p3-runtime-app' : 'p3-runtime-dev');
      const runtimeRoot = packaged
        ? join(testBundle(), 'Contents/Resources/runtime')
        : join(testAppDir(), 'runtime/darwin-arm64');
      const inventory = verifyRuntime(runtimeRoot),
        fixture = await modelFixture();
      const app = await startApp(root, { packaged, testModelBaseUrl: fixture.baseUrl });
      try {
        await configure(app.page);
        const source = String.raw`import json,sys,os,importlib.metadata
from pathlib import Path
import pandas,numpy,matplotlib.pyplot as plt,seaborn
plt.plot([1,2],[4,3]); plt.title('地区销售变化'); plt.savefig('中文图表.png'); plt.close()
Path('report.md').write_text('# Runtime delivery\n',encoding='utf-8')
print(json.dumps({'python':sys.executable,'libraries':{n:importlib.metadata.version(n) for n in ['pandas','numpy','matplotlib','seaborn','psutil','pillow','jsonschema']},'credentialInherited':any('API_KEY' in k or k=='P3_SECRET_SENTINEL' for k in os.environ)}))
`;
        fixture.set(
          { tool: { name: 'write', args: { path: 'runtime_probe.py', content: source } } },
          {
            tool: {
              name: 'bash',
              args: { command: 'python3 runtime_probe.py && rg --version && fd --version' },
            },
          },
          { tool: { name: 'read', args: { path: 'report.md' } } },
          { text: 'Runtime checked.' },
        );
        const sessionId = await submit(app.page),
          final = await settled(app.page, sessionId);
        assert.equal(final.state, 'completed');
        assert.equal(final.tools.length, 3);
        assert(
          final.tools.every((tool) => tool.status === 'completed'),
          JSON.stringify(final.tools),
        );
        const output = final.tools.find((tool) => tool.name === 'bash').output;
        const result = JSON.parse(output.split('\n').find((line) => line.startsWith('{')));
        assert.equal(result.credentialInherited, false);
        assert.equal(result.python, join(runtimeRoot, 'python/bin/python3'));
        assert.deepEqual(result.libraries, inventory.libraries);
        assert(!/Glyph .* missing/.test(output));
        assert(output.includes('ripgrep 15.2.0') && output.includes('fd 10.5.1'));
        assert(
          statSync(
            join(final.outputDirectory ?? join(root, 'data/workspace', sessionId), '中文图表.png'),
          ).size > 100,
        );
        assert(
          final.tools.find((tool) => tool.name === 'read').output.includes('# Runtime delivery'),
        );
        assert.deepEqual(app.errors, []);
        evidence.push({
          packaged,
          inventory,
          python: result.python,
          chinesePng: true,
          toolEnvironmentNoKey: true,
        });
      } finally {
        await app.stop();
        await fixture.close();
      }
    }
    return evidence;
  },
};
