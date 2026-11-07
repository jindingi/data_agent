import { join } from 'node:path';
import { runFollowup } from '../../../scripts/eval/run-followup.mjs';

export const cases = {
  'conversation.live-resume': ({ dir }) => runFollowup(join(dir, 'p5-live-resume')),
};
