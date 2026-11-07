import { join } from 'node:path';
import { runFollowup } from '../../../scripts/eval/run-followup.mjs';

export const cases = {
  'packaging.live-analysis': ({ dir }) => runFollowup(join(dir, 'p7-live'), { packaged: true }),
};
