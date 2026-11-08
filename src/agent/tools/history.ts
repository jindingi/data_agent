import { declarationsEqual, type Tool } from '@earendil-works/pi-ai';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { TSchema } from 'typebox';
import version1 from './declarations-v1.json';

/** Restore only exact, known declarations. Never replace arbitrary historical prompt/tool text. */
export function restoreToolDeclarations(
  current: ToolDefinition[],
  recorded: Tool[],
): ToolDefinition[] {
  return current.map((tool) => {
    const previous = recorded.find((declaration) => declaration.name === tool.name);
    if (!previous || declarationsEqual(previous, tool)) return tool;
    const legacy = version1.find((declaration) => declaration.name === tool.name);
    if (!legacy || !declarationsEqual(previous, legacy)) return tool;
    return {
      ...tool,
      description: previous.description,
      parameters: previous.parameters as TSchema,
    };
  });
}
