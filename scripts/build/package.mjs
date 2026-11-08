import { prepareArtifacts, artifactOptions } from './artifacts.mjs';

const context = prepareArtifacts({ ...artifactOptions(process.argv.slice(2)), packaged: true });
console.log(JSON.stringify({ status: 'ready', ...context }));
