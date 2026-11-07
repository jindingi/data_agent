import { getCurrentSystemMessage, getSystemMessageText } from '@earendil-works/pi-ai';
import { SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { dirname } from 'node:path';
import type { AgentBinding, AgentPromptView } from '../shared/agent-config';
import { inspectSessionFile } from '../node/session-integrity';
import { verifyBinding } from '../node/agent-config-resources';
import { AppError } from '../shared/errors';
import { configurationResources } from './agent-configuration';
import { createModelRuntime } from './models';
import { genericTools } from './tools';
import { createWorkbenchSession } from './workbench-session';

export async function previewAgentPrompt(
  binding: AgentBinding,
  workspace: string,
  history?: { file: string; piSessionId: string },
): Promise<AgentPromptView> {
  verifyBinding(binding);
  if (history) {
    const inspected = inspectSessionFile(history.file, history.piSessionId, true);
    if (inspected.state !== 'persisted')
      throw new AppError('HISTORY_UNAVAILABLE', inspected.error || '会话历史不可用');
    const manager = SessionManager.open(history.file, dirname(history.file), workspace);
    const system = getCurrentSystemMessage(manager.buildSessionProjection().messages);
    if (system) return { text: getSystemMessageText(system), source: 'history' };
  }
  const runtime = await createModelRuntime();
  const { prompt, skills } = configurationResources(binding, workspace);
  const tools = genericTools(
    {
      execute: async () => {
        throw new Error('Prompt preview cannot execute tools');
      },
      subscribe: () => () => {},
    },
    (value) => value,
  ).filter((tool) =>
    binding.config.enabledTools.includes(tool.name as (typeof binding.config.enabledTools)[number]),
  );
  const { session } = await createWorkbenchSession({
    cwd: workspace,
    agentDir: workspace,
    sessionManager: SessionManager.inMemory(workspace),
    settingsManager: SettingsManager.inMemory({ cacheWarming: 'off' }),
    modelRuntime: runtime,
    model: runtime.getModel('deepseek', 'deepseek-flash'),
    resources: { systemPrompt: prompt, skills },
    registeredTools: tools,
  });
  try {
    return { text: session.systemPrompt, source: 'assembled' };
  } finally {
    session.dispose();
  }
}
