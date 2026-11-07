import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { startApp } from './harness.mjs';
const build = spawnSync('pnpm', ['build'], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status || 1);
const root = resolve('test-results', `interactive-${Date.now()}`);
const instance = await startApp(root);
console.log(
  JSON.stringify({
    status: 'ready',
    pid: instance.child.pid,
    endpoint: `http://127.0.0.1:${instance.port}`,
    dataDirectory: root,
  }),
);
process.on('SIGINT', () => void instance.stop());
process.on('SIGTERM', () => void instance.stop());
await instance.exit;
