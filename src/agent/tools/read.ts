import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { readText } from '../../node/read-text';
import { toolParameters } from '../../shared/tools';
import { toolDeclaration } from './index';
import { toolLimits } from '../../shared/tool-limits';
/** Read-only SDK harness path; the desktop routes its tools through Main's policy. */
export function readTool(
  workspace: string,
  protectedRoots: string[],
  resultBytes: () => number = () => toolLimits.resultBytes,
): ToolDefinition {
  return {
    ...toolDeclaration('read'),
    async execute(_id, params, signal) {
      const result = await readText(
        workspace,
        protectedRoots,
        toolParameters.read.parse(params),
        signal,
        undefined,
        resultBytes(),
      );
      return { content: [{ type: 'text', text: result.output }], details: result.details };
    },
  };
}
