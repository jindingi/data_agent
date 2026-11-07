import {
  createAgentSession,
  type CreateAgentSessionOptions,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { createResourceLoader } from './resource-loader';

/** One SDK assembly path for execution and read-only, in-memory previews. */
export function createWorkbenchSession(
  options: Omit<CreateAgentSessionOptions, 'resourceLoader' | 'tools' | 'customTools'> & {
    resources: Parameters<typeof createResourceLoader>[0];
    registeredTools: ToolDefinition[];
  },
) {
  const { resources, registeredTools, ...sessionOptions } = options;
  return createAgentSession({
    ...sessionOptions,
    resourceLoader: createResourceLoader(resources),
    tools: registeredTools.map((tool) => tool.name),
    customTools: registeredTools,
  });
}
