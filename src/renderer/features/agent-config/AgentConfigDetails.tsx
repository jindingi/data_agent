import { composeAgentPrompt, toolLabels, type AgentBinding } from '../../../shared/agent-config';

export function AgentConfigDetails({
  binding,
  workspace,
}: {
  binding: AgentBinding;
  workspace: string;
}) {
  return (
    <div className="agent-config-details">
      <p className="config-version">
        {binding.revision === null ? '历史配置 · 从会话记录恢复' : `版本 v${binding.revision}`} ·{' '}
        {new Date(binding.createdAt).toLocaleString()}
      </p>
      <details>
        <summary>系统提示词</summary>
        <pre>{binding.legacyPreamble ?? composeAgentPrompt(workspace, binding.config)}</pre>
      </details>
      <details>
        <summary>启用的工具（{binding.config.enabledTools.length}）</summary>
        {binding.config.enabledTools.length ? (
          <ul>
            {binding.config.enabledTools.map((id) => (
              <li key={id}>
                {toolLabels[id][0]} <code>{id}</code>
              </li>
            ))}
          </ul>
        ) : (
          <p>未启用工具，仅进行对话。</p>
        )}
      </details>
      <details>
        <summary>内置 Skills（{binding.skills.length}）</summary>
        {binding.skills.length ? (
          binding.skills.map((skill) => (
            <details key={skill.id}>
              <summary>{skill.name}</summary>
              <pre>{skill.content}</pre>
            </details>
          ))
        ) : (
          <p>未启用内置 Skills。</p>
        )}
      </details>
    </div>
  );
}
