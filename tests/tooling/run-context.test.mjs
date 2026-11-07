import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRunContext } from '../../scripts/test/run-context.mjs';
import { mergeCases, requirementsFor } from '../../scripts/test/case-registry.mjs';

test('test builds have distinct app/build/bundle paths and explicit requirements', () => {
  mkdirSync('test-results', { recursive: true });
  const root = mkdtempSync(resolve('test-results/context-'));
  try {
    const a = createRunContext(join(root, 'a'));
    const b = createRunContext(join(root, 'b'));
    for (const key of ['appDir', 'buildDir', 'releaseDir', 'bundlePath']) {
      assert.notEqual(a[key], b[key]);
      assert(a[key].startsWith(root + '/'));
    }
    assert.equal(
      JSON.parse(readFileSync(join(a.appDir, 'package.json'))).main,
      'out/main/index.js',
    );
    assert.equal(requirementsFor(['P0-DEV']).build, false);
    assert.equal(requirementsFor(['P1-SCHEMA']).build, false);
    assert.equal(requirementsFor(['P0-PACKAGE']).packaged, true);
    assert.equal(requirementsFor(['P7-USABILITY']).packaged, false);
    assert.throws(() => mergeCases({ A() {} }, { A() {} }), /Duplicate/);
    assert.throws(() => mergeCases({ A: null }), /invalid/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
