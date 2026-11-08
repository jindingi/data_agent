import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  writeFileSync,
  existsSync,
  lstatSync,
  unlinkSync,
  symlinkSync,
  realpathSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  prepareArtifacts,
  validateArtifacts,
  sourceFingerprint,
  artifactOptions,
  devArguments,
} from '../../scripts/build/artifacts.mjs';
import {
  withRunContext,
  runContext,
  testAppDir,
  testBuildDir,
  testBundle,
} from '../../scripts/test/run-context.mjs';
import { verifyRelease } from '../../scripts/build/verify-release.mjs';
import { validateCatalog, requirementsFor } from '../../scripts/test/case-registry.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'artifact-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'source');
  mkdirSync(sourceRoot);
  const put = (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  put(
    join(sourceRoot, 'package.json'),
    JSON.stringify({ name: 'fixture', main: 'out/main/index.js' }),
  );
  put(join(sourceRoot, 'pnpm-lock.yaml'), 'lock fixture');
  put(join(sourceRoot, '.gitignore'), 'out/\nrelease/\nnode_modules/\nruntime/\n');
  put(join(sourceRoot, 'src/source.txt'), 'source');
  put(join(sourceRoot, 'resources/runtime-lock.json'), 'locked resource');
  put(join(sourceRoot, 'runtime/fixture'), 'runtime');
  put(join(sourceRoot, 'node_modules/better-sqlite3/prebuilds/darwin-arm64.node'), 'native ABI');
  put(join(sourceRoot, 'out/sentinel'), 'shared build');
  put(join(sourceRoot, 'release/sentinel'), 'shared package');
  execFileSync('git', ['init', '-q'], { cwd: sourceRoot });
  const commands = [];
  const adapter = {
    sourceRoot,
    prepareResources() {},
    command(label, args, context) {
      commands.push({ label, args, context });
      assert.equal(context.sourceRoot, sourceRoot);
      if (label === 'build') {
        assert.equal(args.at(-1), context.buildDir);
        for (const name of [
          'main/index.js',
          'main/agent.js',
          'preload/index.cjs',
          'renderer/index.html',
        ])
          put(join(context.buildDir, name), `compiled ${name}`);
      }
      if (label === 'package-dependencies') {
        assert.equal(args[1], context.packageAppDir);
        assert(args.includes('--offline') && args.includes('--ignore-scripts'));
        mkdirSync(join(context.packageAppDir, 'node_modules/better-sqlite3/prebuilds'), {
          recursive: true,
        });
      }
      if (label === 'package') {
        assert(args.includes(`--config.directories.output=${context.releaseDir}`));
        assert(args.includes(`--config.directories.app=${context.packageAppDir}`));
        put(join(context.bundlePath, 'Contents/Resources/app.asar'), 'package');
      }
    },
    verifyPackage(bundle, buildDir) {
      assert.equal(readFileSync(join(buildDir, 'main/index.js'), 'utf8'), 'compiled main/index.js');
      return { asarSha256: readFileSync(join(bundle, 'Contents/Resources/app.asar'), 'utf8') };
    },
  };
  const prepare = (name, options = {}, dependencies = adapter) =>
    prepareArtifacts({ root: join(root, name), ...options }, dependencies);
  return { root, sourceRoot, put, adapter, commands, prepare };
}

test('built and packaged artifacts leave source outputs and dependency links unchanged', (t) => {
  const f = fixture(t),
    a = f.prepare('a', { packaged: true }),
    b = f.prepare('b');
  for (const key of ['appDir', 'buildDir', 'releaseDir', 'bundlePath'])
    assert.notEqual(a[key], b[key]);
  assert.equal(readFileSync(join(f.sourceRoot, 'out/sentinel'), 'utf8'), 'shared build');
  assert.equal(readFileSync(join(f.sourceRoot, 'release/sentinel'), 'utf8'), 'shared package');
  assert(lstatSync(join(a.appDir, 'node_modules')).isSymbolicLink());
  assert(!lstatSync(join(a.packageAppDir, 'node_modules')).isSymbolicLink());
  assert.equal(
    readFileSync(
      join(a.packageAppDir, 'node_modules/better-sqlite3/prebuilds/darwin-arm64.node'),
      'utf8',
    ),
    'native ABI',
  );
  assert.equal(validateArtifacts(a).fingerprint, a.fingerprint);
  assert.equal(f.prepare('a', { packaged: true, reusePackage: true }).fingerprint, a.fingerprint);
  assert.throws(() => f.prepare('a'), /already contains/);
});

for (const file of ['src/source.txt', 'pnpm-lock.yaml', 'resources/runtime-lock.json'])
  test(`source provenance refuses reuse after changing ${file}`, (t) => {
    const f = fixture(t);
    f.prepare('build');
    f.put(join(f.sourceRoot, file), 'changed');
    assert.throws(() => f.prepare('build', { reuseBuild: true }), /stale/);
  });

test('reuse refuses missing, modified and redirected outputs and resources', (t) => {
  const f = fixture(t),
    a = f.prepare('a');
  f.put(join(a.buildDir, 'main/index.js'), 'replaced');
  assert.throws(() => f.prepare('a', { reuseBuild: true }), /changed/);
  assert.throws(() => f.prepare('missing', { reuseBuild: true }), /Missing/);
  const b = f.prepare('b');
  unlinkSync(join(b.appDir, 'resources'));
  symlinkSync(join(f.root, 'missing'), join(b.appDir, 'resources'));
  assert.throws(() => validateArtifacts(b));
  const c = f.prepare('c');
  rmSync(join(c.buildDir, 'main/agent.js'));
  assert.throws(() => validateArtifacts(c), /Incomplete/);
  const other = fixture(t);
  assert.throws(() => validateArtifacts({ ...c, sourceRoot: other.sourceRoot }), /stale/);
});

test('failed build and concurrent source changes never acquire a successful receipt', (t) => {
  const f = fixture(t);
  assert.throws(
    () =>
      f.prepare(
        'failed',
        {},
        {
          ...f.adapter,
          command() {
            throw new Error('compile failed');
          },
        },
      ),
    /compile failed/,
  );
  assert.equal(existsSync(join(f.root, 'failed/artifacts.json')), false);
  assert.throws(
    () =>
      f.prepare(
        'changing',
        {},
        {
          ...f.adapter,
          command(...args) {
            f.adapter.command(...args);
            f.put(join(f.sourceRoot, 'src/source.txt'), 'concurrent change');
          },
        },
      ),
    /Source changed/,
  );
  assert.equal(existsSync(join(f.root, 'changing/artifacts.json')), false);
});

test('failed packaging keeps the built app usable without a successful package receipt', (t) => {
  const f = fixture(t),
    a = f.prepare('a');
  assert.throws(
    () =>
      f.prepare(
        'a',
        { reuseBuild: true, packaged: true },
        {
          ...f.adapter,
          verifyPackage() {
            throw new Error('bad package');
          },
        },
      ),
    /bad package/,
  );
  assert.equal(validateArtifacts(a).fingerprint, a.fingerprint);
  assert.equal(JSON.parse(readFileSync(join(a.root, 'artifacts.json'))).packaged, undefined);
  assert(lstatSync(join(a.appDir, 'node_modules')).isSymbolicLink());
});

test('shared roots, symlink aliases and implicit reuse are rejected before building', (t) => {
  const f = fixture(t);
  for (const root of [f.sourceRoot, join(f.sourceRoot, 'out/run'), join(f.sourceRoot, 'release')])
    assert.throws(() => prepareArtifacts({ root }, f.adapter), /separate/);
  symlinkSync(join(f.sourceRoot, 'out'), join(f.root, 'alias'));
  assert.throws(() => prepareArtifacts({ root: join(f.root, 'alias/run') }, f.adapter), /separate/);
  assert.throws(() => prepareArtifacts({ reuseBuild: true }, f.adapter), /run-root/);
  assert.throws(() => prepareArtifacts({ reusePackage: true }, f.adapter), /run-root/);
  assert.throws(() => artifactOptions(['--run-root']), /Missing/);
  assert.throws(() => artifactOptions(['--surprise']), /Unknown/);
  assert.deepEqual(artifactOptions(['--', '--run-root', '/tmp/example', '--no-build']), {
    root: '/tmp/example',
    reuseBuild: true,
  });
});

test('artifact execution scopes isolate concurrent and nested readers without environment fallback', async (t) => {
  const f = fixture(t),
    a = f.prepare('a'),
    b = f.prepare('b');
  assert.throws(() => testAppDir(), /context/);
  assert.throws(() => verifyRelease(), /Explicit/);
  await Promise.all(
    [a, b].map((context) =>
      withRunContext(context, async () => {
        await Promise.resolve();
        assert.equal(testAppDir(), context.appDir);
        assert.equal(testBuildDir(), context.buildDir);
        assert.equal(testBundle(), context.bundlePath);
        withRunContext(context === a ? b : a, () => assert.notEqual(runContext(), context));
        assert.equal(runContext(), context);
      }),
    ),
  );
  assert.throws(() => runContext(), /context/);
});

test('real dev output uses a fresh context and requirements remain explicit', (t) => {
  const f = fixture(t),
    context = f.prepare('dev', { build: false, dev: true });
  const args = devArguments(context, { port: 9000, automation: true, background: true });
  assert.deepEqual(args.slice(0, 3), ['exec', 'electron-vite', 'dev']);
  assert.equal(args[args.indexOf('--outDir') + 1], context.buildDir);
  assert(args.includes(join(context.buildDir, 'main/index.js')));
  assert(args.includes('--data-agent-background'));
  assert.equal(f.commands.length, 0);
  assert.equal(sourceFingerprint(f.sourceRoot), context.fingerprint);
  assert.equal(requirementsFor(['P0-DEV']).build, false);
  assert.equal(requirementsFor(['P1-SCHEMA']).build, false);
  assert.equal(requirementsFor(['P0-PACKAGE']).packaged, true);
  assert.equal(requirementsFor(['P7-USABILITY']).packaged, false);
  assert.throws(() => validateCatalog([{ id: 'invalid' }]), /invalid/);
  assert.throws(() => requirementsFor(['missing.test']), /Unknown/);
});
