import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { readText } from '../../node/read-text';
const parameters = Type.Object({ path: Type.String(), offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 2000 })) });
/** Read-only SDK harness path; the desktop routes its tools through Main's policy. */
export function readTool(workspace: string, protectedRoots: string[]): ToolDefinition<typeof parameters> {
  return { name: 'read', label: '读取文件', description: 'Read text files with bounded output and 1-based line offset.', parameters,
    async execute(_id, params, signal) { const result = await readText(workspace, protectedRoots, params, signal); return { content: [{type: 'text', text: result.output}], details: result.details }; },
  };
}
