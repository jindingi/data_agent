import { spawnSync } from 'node:child_process';
import { cpSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRunContext, preparePackageDependencies } from '../test/run-context.mjs';

const run = (label, args) => {
  const result = spawnSync('pnpm', args, { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${label} failed (${result.status})`);
};
run('runtime', ['runtime:verify']);
run('build', ['build']);
const context = createRunContext(resolve('.local', `package-${Date.now()}`));
cpSync('out', context.buildDir, { recursive: true });
preparePackageDependencies(context, run);
run('package', [
  'exec',
  'electron-builder',
  '--mac',
  'dir',
  '--arm64',
  `--config.directories.app=${context.appDir}`,
  `--config.directories.output=${resolve('release')}`,
]);
