import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, lstatSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyRuntime } from './verify-runtime.mjs';
const require = createRequire(import.meta.url);
const builder = createRequire(require.resolve('electron-builder/package.json'));
const dependencies = createRequire(builder.resolve('app-builder-lib/package.json'));
const asar = dependencies('@electron/asar');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function files(root) {
  return readdirSync(root).flatMap((name) => {
    const p = join(root, name);
    return lstatSync(p).isDirectory() ? files(p) : [p];
  });
}
export function verifyRelease(
  bundle,
  buildDir,
  sourceRoot = fileURLToPath(new URL('../../', import.meta.url)),
) {
  if (!bundle || !buildDir) throw new Error('Explicit bundle and build paths are required');
  const resources = join(bundle, 'Contents/Resources'),
    archive = join(resources, 'app.asar');
  assert(existsSync(archive), 'Build the actual .app first');
  const runtime = verifyRuntime(join(resources, 'runtime'));
  const inventory = asar.listPackage(archive).map((p) => p.replace(/^\//, ''));
  assert(
    !inventory.some((p) => /^(test-results|evaluations|validation|\.env|src\/|scripts\/)/.test(p)),
    'Development state bundled',
  );
  const checked = [];
  for (const file of files(buildDir)) {
    const path = join('out', relative(buildDir, file)),
      bytes = asar.extractFile(archive, path);
    assert.equal(hash(bytes), hash(readFileSync(file)), `Stale packaged application code: ${path}`);
    assert(
      !bytes.includes(sourceRoot) && !bytes.includes(homedir() + sep),
      'Application code includes a developer absolute path',
    );
    checked.push({ path, sha256: hash(bytes) });
  }
  for (const [source, target] of [
    ['resources/python', 'python'],
    ['resources/skills', 'skills'],
    ['resources/examples', 'examples'],
  ])
    for (const file of files(join(sourceRoot, source)).filter(
      (f) => !f.includes('__pycache__') && !f.endsWith('.pyc'),
    )) {
      const path = join(target, relative(join(sourceRoot, source), file)),
        bytes = readFileSync(join(resources, path));
      assert.equal(hash(bytes), hash(readFileSync(file)), `Stale bundled resource ${path}`);
      checked.push({ path, sha256: hash(bytes) });
    }
  const reportLock = JSON.parse(
    readFileSync(join(sourceRoot, 'resources/echarts-lock.json'), 'utf8'),
  );
  for (const [name, item] of Object.entries(reportLock.files)) {
    const bytes = readFileSync(join(resources, 'report-runtime', name));
    assert.equal(hash(bytes), item.sha256, `Stale bundled report runtime ${name}`);
    checked.push({ path: `report-runtime/${name}`, sha256: item.sha256 });
  }
  const manifest = JSON.parse(readFileSync(join(resources, 'runtime/manifest.json'), 'utf8'));
  const licenses = Object.keys(manifest.files).filter((p) =>
    /LICENSE|COPYING|licenses\/.*OFL/.test(p),
  );
  assert(licenses.includes('python/lib/python3.12/LICENSE.txt'));
  assert(licenses.includes('licenses/font-OFL.txt'));
  for (const name of Object.keys(runtime.libraries))
    assert(
      licenses.some((p) => p.toLowerCase().includes(`/${name}-`)),
      `Missing bundled Python license for ${name}`,
    );
  const executable = join(bundle, 'Contents/MacOS/Data Agent');
  assert(execFileSync('/usr/bin/file', ['-b', executable], { encoding: 'utf8' }).includes('arm64'));
  for (const binary of ['python/bin/python3.12', 'bin/rg', 'bin/fd'])
    assert(
      execFileSync('/usr/bin/file', ['-b', join(resources, 'runtime', binary)], {
        encoding: 'utf8',
      }).includes('arm64'),
    );
  const native = inventory.filter(
    (p) => p === 'node_modules/better-sqlite3/prebuilds/darwin-arm64.node',
  );
  assert.equal(native.length, 1);
  assert(
    execFileSync('/usr/bin/file', ['-b', join(resources, 'app.asar.unpacked', native[0])], {
      encoding: 'utf8',
    }).includes('arm64'),
  );
  const metadata = JSON.parse(asar.extractFile(archive, 'package.json'));
  assert.equal(
    metadata.version,
    JSON.parse(readFileSync(join(sourceRoot, 'package.json'))).version,
  );
  return {
    bundle,
    version: metadata.version,
    architecture: 'arm64',
    runtime,
    licenseFiles: licenses.length,
    verifiedApplicationFiles: checked,
    asarSha256: hash(readFileSync(archive)),
    nativeSQLiteSha256: hash(readFileSync(join(resources, 'app.asar.unpacked', native[0]))),
    scope:
      'Static packaged code/resource/hash/license checks; actual UI, ABI and live checks are P7 phase cases.',
  };
}
