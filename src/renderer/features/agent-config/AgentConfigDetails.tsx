import { toolLabels, type AgentBinding, type AgentPromptView } from '../../../shared/agent-config';

export function AgentConfigDetails({
  binding,
  prompt,
}: {
  binding: AgentBinding;
  prompt?: AgentPromptView;
}) {
  return (
    <div className="agent-config-details">
      <p className="config-version">
        {binding.revision === null ? '历史配置 · 从会话记录恢复' : `版本 v${binding.revision}`} ·{' '}
        {new Date(binding.createdAt).toLocaleString()}
      </p>
      <details>
        <summary>系统提示词</summary>
        <p>
          {prompt?.source === 'history'
            ? '来自此会话原生记录中的当前系统提示词。'
            : '尚无已记录的系统提示词，以下按此会话固定配置组装。'}
        </p>
        {prompt ? <pre aria-label="会话系统提示词">{prompt.text}</pre> : <p>系统提示词不可用。</p>}
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
