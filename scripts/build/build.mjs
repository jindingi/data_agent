import { prepareArtifacts, artifactOptions } from './artifacts.mjs';

console.log(
  JSON.stringify({ status: 'ready', ...prepareArtifacts(artifactOptions(process.argv.slice(2))) }),
);
