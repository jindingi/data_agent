import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  existsSync,
  copyFileSync,
  lstatSync,
  unlinkSync,
} from 'node:fs';
import { resolve, join } from 'node:path';

/** All test builds live under the run, including the app root used by Electron. */
export function createRunContext(root) {
  const appDir = join(resolve(root), 'app');
  const buildDir = join(appDir, 'out');
  const releaseDir = join(resolve(root), 'release');
  mkdirSync(appDir, { recursive: true });
  const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
  writeFileSync(join(appDir, 'package.json'), JSON.stringify(metadata, null, 2));
  for (const name of ['node_modules', 'runtime', 'resources']) {
    const target = join(appDir, name);
    if (!existsSync(target)) symlinkSync(resolve(name), target, 'dir');
  }
  return {
    root: resolve(root),
    appDir,
    buildDir,
    releaseDir,
    bundlePath: join(releaseDir, 'mac-arm64/Data Agent.app'),
  };
}

/** Builder must see a real production dependency tree, not a symlink to dev tools. */
export function preparePackageDependencies(context, run) {
  const modules = join(context.appDir, 'node_modules');
  if (lstatSync(modules).isSymbolicLink()) unlinkSync(modules);
  copyFileSync('pnpm-lock.yaml', join(context.appDir, 'pnpm-lock.yaml'));
  run('package-dependencies', [
    '--dir',
    context.appDir,
    'install',
    '--prod',
    '--frozen-lockfile',
    '--ignore-scripts',
    '--offline',
    '--node-linker=hoisted',
  ]);
  // Preserve the already verified Electron ABI binary; installing does not run rebuild scripts.
  copyFileSync(
    resolve('node_modules/better-sqlite3/prebuilds/darwin-arm64.node'),
    join(modules, 'better-sqlite3/prebuilds/darwin-arm64.node'),
  );
}

export function setRunContext(context) {
  process.env.DATA_AGENT_TEST_APP_DIR = context.appDir;
  process.env.DATA_AGENT_TEST_BUILD_DIR = context.buildDir;
  process.env.DATA_AGENT_TEST_BUNDLE = context.bundlePath;
}
export const testAppDir = () => resolve(process.env.DATA_AGENT_TEST_APP_DIR ?? '.');
export const testBuildDir = () => resolve(process.env.DATA_AGENT_TEST_BUILD_DIR ?? 'out');
export const testBundle = () =>
  resolve(process.env.DATA_AGENT_TEST_BUNDLE ?? 'release/mac-arm64/Data Agent.app');
