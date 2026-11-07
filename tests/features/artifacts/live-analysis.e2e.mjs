import { join } from 'node:path';
import { runScenario } from '../../../scripts/eval/run-scenario.mjs';

export const cases = {
  async 'artifacts.live-analysis'({ dir }) {
    return runScenario('J1-SALES', join(dir, 'p4-live-sales'));
  },
};
