import { artifactOptions, loadArtifacts } from './artifacts.mjs';
import { verifyRelease } from './verify-release.mjs';

const options = artifactOptions(process.argv.slice(2));
if (!options.root || options.reuseBuild || options.reusePackage)
  throw new Error('Usage: pnpm verify:release -- --run-root <artifact-root>');
const context = loadArtifacts(options.root, { packaged: true });
console.log(JSON.stringify(verifyRelease(context.bundlePath, context.buildDir), null, 2));
