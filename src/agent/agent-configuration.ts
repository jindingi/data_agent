import { AppError } from '../shared/errors';
import { declarationsEqual, getCurrentSystemMessage, getCurrentTools } from '@earendil-works/pi-ai';
import {
  formatSkillsForPrompt,
  type SessionManager,
  type Skill,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import { dirname } from 'node:path';
import { verifyBinding } from '../node/agent-config-resources';
import { composeAgentPrompt, type AgentBinding } from '../shared/agent-config';

export function configuredSkills(binding: AgentBinding): Skill[] {
  return binding.skills.map((s) => ({
    name: s.name,
    description: s.description,
    filePath: s.filePath,
    baseDir: dirname(s.filePath),
    disableModelInvocation: false,
    sourceInfo: { path: s.filePath, source: 'bundled', scope: 'temporary', origin: 'top-level' },
  }));
}
export function configurationResources(binding: AgentBinding, workspace: string) {
  return {
    prompt: composeAgentPrompt(workspace, binding.config),
    skills: configuredSkills(binding),
  };
}
/** Check before allowing pi to rebuild a prompt. Never silently patch an existing prefix. */
export function bindAgentConfiguration(
  manager: SessionManager,
  binding: AgentBinding,
  workspace: string,
  tools: ToolDefinition[],
) {
  verifyBinding(binding);
  const markers = manager
    .getEntries()
    .filter((e) => e.type === 'custom' && e.customType === 'data_agent.agent_config');
  if (
    markers.some(
      (e) =>
        e.type === 'custom' &&
        ((e.data as { fingerprint?: string }).fingerprint !== binding.fingerprint ||
          (e.data as { revision?: number | null }).revision !== binding.revision),
    )
  )
    throw new AppError(
      'AGENT_CONFIG_UNAVAILABLE',
      '配置待确认：会话 JSONL 与 SQLite 中的 Agent 配置不一致，请恢复匹配备份。',
    );
  const messages = manager.buildSessionProjection().messages;
  const previous = getCurrentSystemMessage(messages);
  const { prompt, skills } = configurationResources(binding, workspace);
  if (previous) {
    const expectedSkills = skills.length
      ? `<skills>\n${formatSkillsForPrompt(skills).trim()}\n</skills>`
      : undefined;
    const expectedSections = {
      preamble: prompt,
      ...(expectedSkills ? { skills: expectedSkills } : {}),
      cwd: `<cwd>\n${workspace.replace(/\\/g, '/')}\n</cwd>`,
    };
    const previousTools = getCurrentTools(messages);
    if (
      !!previous.content ||
      JSON.stringify(previous.sections) !== JSON.stringify(expectedSections) ||
      previousTools.length !== tools.length ||
      previousTools.some((tool, index) => !declarationsEqual(tool, tools[index]))
    )
      throw new AppError(
        'AGENT_CONFIG_UNAVAILABLE',
        '配置待确认：历史提示词、skill 索引或工具声明与运行时不兼容，已停止以保留上下文，请新建会话。',
      );
  }
  if (!markers.length)
    manager.appendCustomEntry('data_agent.agent_config', {
      fingerprint: binding.fingerprint,
      revision: binding.revision,
    });
  return { prompt, skills };
}
