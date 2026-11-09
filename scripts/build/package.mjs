import { prepareArtifacts, artifactOptions } from './artifacts.mjs';

const args = process.argv.slice(2);
const context = prepareArtifacts({
  ...artifactOptions(args.filter((arg) => arg !== '--dmg')),
  packaged: true,
  dmg: args.includes('--dmg'),
});
console.log(JSON.stringify({ status: 'ready', ...context }));
