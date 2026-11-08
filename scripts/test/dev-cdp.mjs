import { resolve } from 'node:path';
import { startApp } from './harness.mjs';
import { prepareArtifacts, artifactOptions } from '../build/artifacts.mjs';
const artifacts = prepareArtifacts(artifactOptions(process.argv.slice(2)));
const root = resolve(artifacts.root, 'application');
const instance = await startApp(root, { artifacts });
console.log(
  JSON.stringify({
    status: 'ready',
    pid: instance.child.pid,
    endpoint: `http://127.0.0.1:${instance.port}`,
    dataDirectory: root,
    artifacts,
  }),
);
process.on('SIGINT', () => void instance.stop());
process.on('SIGTERM', () => void instance.stop());
await instance.exit;
