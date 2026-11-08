import {
  agentConfigSchema,
  normalizeAgentConfig,
  toolIds,
  toolLabels,
} from '../../../shared/agent-config';
import { Button } from '../../components/ui/button';
import type { AgentConfigController } from './use-agent-config';
import { PromptPreview } from './PromptPreview';

export function AgentConfigSettings({ controller }: { controller: AgentConfigController }) {
  const { settings, draft, setDraft, busy, error, notice } = controller;
  if (!settings || !draft)
    return (
      <section className="settings-section">
        <p role={error ? 'alert' : 'status'}>{error || '正在加载 Agent 配置…'}</p>
        {error && (
          <Button onClick={() => void controller.reload()} disabled={busy}>
            重新加载
          </Button>
        )}
      </section>
    );
  const conflict = !agentConfigSchema.safeParse(draft).success;
  return (
    <div className="agent-config-editor">
      <header className="settings-section">
        <h3>Agent 配置</h3>
        <p className="config-version">版本 v{settings.current.revision} · 用于新会话</p>
        <p>已有会话保持创建时的配置。</p>
      </header>
      {error && (
        <p role="alert" className="maintenance-error">
          {error}{' '}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void controller.reload()}
            disabled={busy}
          >
            重新加载已保存配置
          </Button>
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <section className="settings-section">
        <label htmlFor="agent-system-prompt">行为指令</label>
        <p id="agent-prompt-description">
          编辑 Agent 的通用行为。完整提示词还包含应用环境说明、已启用的 Skills 索引和工作目录。
        </p>
        <textarea
          id="agent-system-prompt"
          aria-describedby="agent-prompt-description"
          className="agent-prompt-editor"
          value={draft.systemPrompt}
          disabled={busy}
          maxLength={32000}
          spellCheck={false}
          onChange={(event) => setDraft({ ...draft, systemPrompt: event.target.value })}
        />
        <div className="config-inline-actions">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || draft.systemPrompt === settings.defaults.systemPrompt}
            onClick={() => setDraft({ ...draft, systemPrompt: settings.defaults.systemPrompt })}
          >
            恢复默认行为指令
          </Button>
          <span>{draft.systemPrompt.length.toLocaleString()} / 32,000 字符</span>
        </div>
        <PromptPreview config={draft} revision={settings.current.revision!} />
      </section>
      <section className="settings-section">
        <h3>工具</h3>
        <p>控制可调用接口，不替代权限策略。保留 bash 时，即使关闭 write，仍可能通过命令写文件。</p>
        {toolIds.map((id) => (
          <label className="config-toggle-row" key={id}>
            <span>
              <strong>
                {toolLabels[id][0]} <code>{id}</code>
              </strong>
              <small>{toolLabels[id][1]}</small>
            </span>
            <input
              type="checkbox"
              role="switch"
              aria-label={`启用 ${id}`}
              checked={draft.enabledTools.includes(id)}
              disabled={busy}
              onChange={(event) => {
                const enabledTools = toolIds.filter((tool) =>
                  tool === id ? event.target.checked : draft.enabledTools.includes(tool),
                );
                setDraft({ ...draft, enabledTools });
              }}
            />
          </label>
        ))}
        {!draft.enabledTools.length && <p>未启用工具：新会话只能对话，无法读取文件或执行命令。</p>}
      </section>
      <section className="settings-section">
        <h3>内置 Skills</h3>
        <p>为 Agent 提供工作方法，是否使用由任务决定；不代表每轮自动执行。</p>
        {settings.availableSkills.map((skill) => (
          <div key={skill.id}>
            <label className="config-toggle-row">
              <span>
                <strong>
                  {skill.label} <code>{skill.name}</code>
                </strong>
                <small>{skill.description}</small>
              </span>
              <input
                type="checkbox"
                role="switch"
                aria-label={`启用 ${skill.id}`}
                checked={draft.enabledSkills.includes(skill.id)}
                disabled={busy}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    enabledSkills: settings.availableSkills
                      .map((s) => s.id)
                      .filter((id) =>
                        id === skill.id ? event.target.checked : draft.enabledSkills.includes(id),
                      ),
                  })
                }
              />
            </label>
            <details className="agent-config-details">
              <summary>查看 {skill.id} 说明</summary>
              <pre>{skill.content}</pre>
            </details>
          </div>
        ))}
        {conflict && (
          <p role="alert" className="maintenance-error">
            启用内置 skill 需要 read 工具。
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                setDraft(
                  normalizeAgentConfig({ ...draft, enabledTools: [...draft.enabledTools, 'read'] }),
                )
              }
            >
              启用 read 并保留 Skills
            </Button>
          </p>
        )}
      </section>
    </div>
  );
}
