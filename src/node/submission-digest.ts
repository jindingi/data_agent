import { createHash } from 'node:crypto';
import type { RunInput } from '../shared/runtime';
/** Receipts prove request identity without retaining another permanent copy of chat text. */
export function submissionDigest(input: RunInput) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        inputId: input.inputId,
        kind: input.kind,
        text: input.text,
        paths: input.paths ?? [],
      }),
    )
    .digest('hex');
}
