import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { catalog, aliases, validateCatalog } from '../../scripts/test/case-registry.mjs';
import { parseArgs, selectTests, affectedCases } from '../../scripts/test/selection.mjs';
const select = (...args) => selectTests(parseArgs(args));

test('default regression is non-live and excludes packaging/performance/recording', () => {
  const plan = select();
  assert(plan.tests.length > 50);
  assert(
    plan.tests.every(
      (t) => t.model !== 'live' && t.environment !== 'packaged' && !t.tags.includes('performance'),
    ),
  );
  assert(select('--level', 'e2e').tests.length > 25);
});
test('feature, level, exact cases and legacy aliases select only named coverage', () => {
  assert(select('--feature', 'usage').tests.every((t) => t.feature === 'usage'));
  assert(
    select('--feature', 'conversation', '--level', 'integration').tests.every(
      (t) => t.level === 'integration' && t.feature === 'conversation',
    ),
  );
  assert.equal(select('--case', 'P4-IMPORT,P4-MULTIFILE').tests.length, 1);
  assert.equal(select('--case', 'P2-LIVE-CACHE').tests[0].id, 'conversation.live-cache');
  assert.throws(() => select('--case', 'no.such-case'), /Unknown/);
  assert.throws(() => select('--feature', 'misspelled'), /Unknown/);
  assert.throws(() => select('P7'), /retired/);
  assert.throws(() => select('--surprise'), /Unknown/);
  assert.throws(() => select('--feature'), /Missing/);
});
test('list exposes live costs; default live selection excludes recording; release contains packaged/performance', () => {
  assert(select('--list').tests.some((t) => t.model === 'live'));
  assert(select('--live').tests.every((t) => t.model === 'live' && !t.tags.includes('recording')));
  const release = select('--suite', 'release');
  assert(release.tests.some((t) => t.environment === 'packaged'));
  assert(release.tests.some((t) => t.tags.includes('performance')));
  assert(release.tests.every((t) => t.model !== 'live'));
  assert(select('--suite', 'release', '--live').requirements.live);
});
test('affected selection follows transitive imports and cross-process boundaries, falls back conservatively', () => {
  const prefix = affectedCases(['src/agent/session-runtime.ts']);
  for (const id of ['conversation.cache-prefix-unit', 'conversation.live-cache', 'usage.details'])
    assert(prefix.has(id), id);
  const direct = affectedCases(['tests/features/usage/details.e2e.mjs']);
  assert(direct.has('usage.details'));
  assert(direct.size < catalog.length);
  assert.equal(affectedCases(['src/shared/runtime.ts']).size, catalog.length);
  assert.equal(affectedCases(['src/new-unmapped-file.ts']).size, catalog.length);
  assert.equal(affectedCases(['tests/features/new/unregistered.e2e.mjs']).size, catalog.length);
  assert.equal(affectedCases(['docs/technical-design.md']).size, 0);
  assert.equal(selectTests({ affected: true }, ['docs/technical-design.md']).tests.length, 0);
});
test('catalog covers every maintained test file and every native/e2e ID exactly once', async () => {
  const files = readdirSync('tests/features', { recursive: true })
    .filter((f) => /\.(unit\.test\.ts|integration\.test\.ts|e2e\.mjs)$/.test(f))
    .map((f) => 'tests/features/' + f);
  const tooling = readdirSync('tests/tooling')
    .filter((f) => f.endsWith('.test.mjs'))
    .map((f) => 'tests/tooling/' + f);
  assert.deepEqual([...new Set(catalog.map((t) => t.file))].sort(), [...files, ...tooling].sort());
  for (const file of files) {
    const entries = catalog.filter((t) => t.file === file);
    assert(
      entries.every((t) => file.startsWith(`tests/features/${t.feature}/`)),
      file,
    );
    if (file.endsWith('.e2e.mjs')) {
      const { cases } = await import('../../' + file);
      assert.deepEqual(Object.keys(cases).sort(), entries.map((t) => t.id).sort(), file);
    } else if (file.endsWith('.integration.test.ts')) {
      const ids = [...readFileSync(file, 'utf8').matchAll(/\bit\('([a-z][a-z0-9.-]+) /g)].map(
        (m) => m[1],
      );
      assert.deepEqual(ids.sort(), entries.map((t) => t.id).sort(), file);
    }
  }
  assert.throws(() => validateCatalog([catalog[0], catalog[0]]), /Duplicate/);
  for (const id of Object.values(aliases)) assert(catalog.some((t) => t.id === id));
});
