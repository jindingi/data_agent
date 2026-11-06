import { createExtensionRuntime, type ResourceLoader } from '@earendil-works/pi-coding-agent';

interface BundledResources {
  systemPrompt: string;
  skills?: ReturnType<ResourceLoader['getSkills']>['skills'];
  extensions?: ReturnType<ResourceLoader['getExtensions']>;
}
/** Explicit application resources only. Never discovers workspace/global files or packages. */
export function createResourceLoader(resources: BundledResources): ResourceLoader {
  const extensions = resources.extensions ?? { extensions: [], errors: [], runtime: createExtensionRuntime() };
  const skills = [...(resources.skills ?? [])];
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills, diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => resources.systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => { /* Dynamic resources are outside the MVP trust boundary. */ },
    reload: async () => { /* Bundled immutable resources need no filesystem discovery. */ },
  };
}
