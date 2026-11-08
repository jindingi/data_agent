import { spawn } from 'node:child_process';
import { prepareArtifacts, artifactOptions, devArguments } from './artifacts.mjs';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const flags = { automation: false, background: false };
for (const key of ['automation', 'background']) {
  const index = args.indexOf(`--${key}`);
  if (index >= 0) {
    flags[key] = true;
    args.splice(index, 1);
  }
}
const index = args.indexOf('--cdp-port');
if (index >= 0) {
  flags.port = Number(args[index + 1]);
  if (!Number.isInteger(flags.port) || flags.port < 1 || flags.port > 65535)
    throw new Error('Invalid --cdp-port');
  args.splice(index, 2);
}
const context = prepareArtifacts({ ...artifactOptions(args), build: false, dev: true });
console.log(JSON.stringify({ status: 'starting', artifacts: context }));
const child = spawn('pnpm', devArguments(context, flags), {
  cwd: context.sourceRoot,
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
