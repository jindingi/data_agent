import { dirname } from 'node:path';
import type { SessionManager } from '@earendil-works/pi-coding-agent';
import type { AgentBinding } from '../shared/agent-config';
import { frozenSkillPath } from '../node/agent-config-resources';

/** Relocation changes execution paths, never previously sent prompts or declarations. */
export function appendResourceLocations(
  manager: SessionManager,
  previousCwd: string | undefined,
  workspace: string,
  binding?: AgentBinding,
  resourcesRoot?: string,
) {
  const skills =
    binding && resourcesRoot
      ? binding.skills.map((skill) => ({
          original: skill.filePath,
          local: frozenSkillPath(resourcesRoot, skill.bundleHash ?? skill.sha256, skill.id),
        }))
      : [];
  if ((!previousCwd || previousCwd === workspace) && skills.every((s) => s.original === s.local))
    return;
  const content = [
    `本会话已迁移到本机工作区：${workspace}。后续工具的默认工作目录和产物目录为此路径。历史路径仅描述先前运行，不要重复执行已完成任务。`,
    '随会话提供的数据位于工作区 data/，分析与报告脚本使用工作区内的相对路径。读取历史附件时请使用本机工作区中的对应文件。',
    ...skills.map(
      (s) =>
        `冻结 skill 本机位置：${s.local}；附属资源位于 ${dirname(s.local)}。历史声明 ${s.original} 的 read 请求也解析到该冻结资源。`,
    ),
  ].join('\n');
  if (
    manager
      .getEntries()
      .some(
        (entry) =>
          entry.type === 'custom_message' &&
          entry.customType === 'data_agent.resource_locations' &&
          entry.content === content,
      )
  )
    return;
  manager.appendCustomMessageEntry('data_agent.resource_locations', content, false);
}
