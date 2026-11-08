import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { artifactOptions, loadArtifacts } from './artifacts.mjs';

const options = artifactOptions(process.argv.slice(2));
if (!options.root || options.reuseBuild || options.reusePackage)
  throw new Error('Usage: pnpm start -- --run-root <artifact-root>');
const context = loadArtifacts(options.root);
const child = spawn(createRequire(import.meta.url)('electron'), [context.appDir], {
  stdio: 'inherit',
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
