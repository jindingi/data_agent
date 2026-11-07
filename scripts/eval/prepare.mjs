import { resolve } from 'node:path';
import { runFollowup } from './run-followup.mjs';
import { runScenario } from './run-scenario.mjs';
const args = process.argv.slice(2).filter((arg) => arg !== '--');
const index = args.indexOf('--case');
const id = index < 0 ? 'J1-SALES' : args[index + 1];
const root = resolve(
  'evaluations/results',
  `${new Date().toISOString().replaceAll(':', '-')}-${id}`,
);
try {
  console.log(
    JSON.stringify(await (id === 'J5-FOLLOWUP' ? runFollowup(root) : runScenario(id, root))),
  );
} catch (error) {
  console.error(String(error));
  process.exitCode = 1;
}
