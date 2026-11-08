import { resolve } from 'node:path';
import { runFollowup } from './run-followup.mjs';
import { runScenario } from './run-scenario.mjs';
import { prepareArtifacts, artifactOptions } from '../build/artifacts.mjs';
import { withRunContext } from '../test/run-context.mjs';
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const index = args.indexOf('--case');
const id = index < 0 ? 'J1-SALES' : args[index + 1];
if (index >= 0) args.splice(index, 2);
const root = resolve(
  'evaluations/results',
  `${new Date().toISOString().replaceAll(':', '-')}-${id}`,
);
try {
  const artifacts = prepareArtifacts(artifactOptions(args));
  process.env.DATA_AGENT_TEST_MODEL_MODE = 'live';
  console.log(
    JSON.stringify(
      await withRunContext(artifacts, () =>
        id === 'J5-FOLLOWUP' ? runFollowup(root) : runScenario(id, root),
      ),
    ),
  );
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
