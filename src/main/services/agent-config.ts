import type Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppPaths } from '../../node/app-paths';
import { inspectSessionFile } from '../../node/session-integrity';
import {
  configDigest,
  frozenSkillPath,
  materializeSkills,
  verifyBinding,
} from '../../node/agent-config-resources';
import { AppError } from '../../shared/errors';
import {
  composeAgentPrompt,
  defaultAgentConfig,
  normalizeAgentConfig,
  toolIds,
  type AgentConfig,
  type AgentBinding,
  type AgentConfigSettings,
  type SessionAgentConfig,
} from '../../shared/agent-config';

/** SQLite owns immutable revisions/bindings. Native JSONL remains the only chat history. */
export class AgentConfigService {
  readonly resourcesRoot: string;
  private bundled: AgentBinding['skills'];
  constructor(
    private db: Database.Database,
    paths: AppPaths,
    skillsDirectory: string,
  ) {
    this.resourcesRoot = join(paths.home, 'agent-resources');
    const content = readFileSync(join(skillsDirectory, 'data-analysis/SKILL.md'), 'utf8');
    const description = content.match(/^description: (.+)$/m)?.[1];
    if (!description || !content.startsWith('---\nname: data-analysis\n'))
      throw new Error('内置 skill 元数据无效');
    const sha256 = configDigest(content);
    this.bundled = [
      {
        id: 'data-analysis',
        name: 'data-analysis',
        description,
        content,
        sha256,
        filePath: frozenSkillPath(this.resourcesRoot, sha256, 'data-analysis'),
      },
    ];
    if (!this.db.prepare('SELECT revision FROM agent_config_revisions LIMIT 1').get())
      this.db.transaction(() => this.insert(defaultAgentConfig))();
  }
  settings(): AgentConfigSettings {
    return {
      current: this.current(),
      defaults: structuredClone(defaultAgentConfig),
      availableSkills: this.editableSkills().map(({ id, name, description, content }) => ({
        id,
        name,
        description,
        content,
      })),
    };
  }
  current(): AgentBinding {
    const row = this.db
      .prepare(
        'SELECT revision,snapshot FROM agent_config_revisions ORDER BY revision DESC LIMIT 1',
      )
      .get() as { revision: number; snapshot: string };
    const binding = verifyBinding(JSON.parse(row.snapshot));
    if (binding.revision !== row.revision) throw new Error('默认配置版本记录不一致');
    return binding;
  }
  save(config: AgentConfig, expectedRevision: number): AgentConfigSettings {
    this.db.transaction(() => {
      const current = this.current();
      if (current.revision !== expectedRevision)
        throw new AppError('CONFIG_CONFLICT', '配置已在其他操作中更新，请重新加载后再保存');
      const skills = this.editableSkills().filter((s) => config.enabledSkills.includes(s.id));
      const next = this.build(normalizeAgentConfig(config), skills);
      if (next.fingerprint !== current.fingerprint) this.insert(config, skills);
    })();
    return this.settings();
  }
  preview(config: AgentConfig, expectedRevision: number): AgentBinding {
    if (this.current().revision !== expectedRevision)
      throw new AppError('CONFIG_CONFLICT', '配置已更新，请重新加载后查看预览');
    return this.build(
      normalizeAgentConfig(config),
      this.editableSkills().filter((s) => config.enabledSkills.includes(s.id)),
    );
  }
  private editableSkills() {
    const saved = this.current().skills;
    return this.bundled.map((skill) => saved.find((s) => s.id === skill.id) ?? skill);
  }
  private build(
    config: AgentConfig,
    skills = this.bundled.filter((s) => config.enabledSkills.includes(s.id)),
    legacyPreamble?: string,
  ): AgentBinding {
    const contents = {
      config: normalizeAgentConfig(config),
      skills,
      promptVersion: 1 as const,
      ...(legacyPreamble === undefined ? {} : { legacyPreamble }),
    };
    return {
      ...contents,
      revision: null,
      fingerprint: configDigest(contents),
      createdAt: new Date().toISOString(),
    };
  }
  private insert(config: AgentConfig, skills?: AgentBinding['skills']) {
    const binding = this.build(normalizeAgentConfig(config), skills);
    materializeSkills(this.resourcesRoot, binding);
    const result = this.db
      .prepare('INSERT INTO agent_config_revisions(snapshot) VALUES (?)')
      .run(JSON.stringify(binding));
    binding.revision = Number(result.lastInsertRowid);
    this.db
      .prepare('UPDATE agent_config_revisions SET snapshot=? WHERE revision=?')
      .run(JSON.stringify(binding), binding.revision);
  }
  /** Called inside the session creation transaction, before any first input can queue. */
  bindNew(sessionId: string) {
    this.db
      .prepare('UPDATE sessions SET agent_config_revision=?,agent_config_override=NULL WHERE id=?')
      .run(this.current().revision, sessionId);
  }
  details(sessionId: string): SessionAgentConfig {
    const row = this.session(sessionId);
    try {
      return {
        binding: this.resolve(sessionId),
        defaultRevision: this.current().revision!,
        error: null,
        workspace: row.workspace,
      };
    } catch (error) {
      return {
        binding: null,
        defaultRevision: this.current().revision!,
        error: error instanceof Error ? error.message : '配置无法恢复',
        workspace: row.workspace,
      };
    }
  }
  require(sessionId: string): AgentBinding {
    try {
      const binding = this.resolve(sessionId);
      materializeSkills(this.resourcesRoot, binding);
      return binding;
    } catch (error) {
      throw new AppError(
        'AGENT_CONFIG_UNAVAILABLE',
        `配置待确认：${error instanceof Error ? error.message : '无法恢复'}。原会话已保留，可使用最新配置新建会话。`,
      );
    }
  }
  private session(id: string) {
    const row = this.db
      .prepare(
        'SELECT workspace,session_file AS file,pi_session_id AS piSessionId,history_known AS known FROM sessions WHERE id=?',
      )
      .get(id) as
      { workspace: string; file: string; piSessionId: string | null; known: number } | undefined;
    if (!row) throw new AppError('SESSION_NOT_FOUND', '会话不存在');
    return row;
  }
  private resolve(id: string): AgentBinding {
    const session = this.session(id);
    const row = this.db
      .prepare(
        'SELECT COALESCE(s.agent_config_override,r.snapshot) AS snapshot FROM sessions s LEFT JOIN agent_config_revisions r ON r.revision=s.agent_config_revision WHERE s.id=?',
      )
      .get(id) as { snapshot: string | null } | undefined;
    if (row && row.snapshot !== null) {
      const binding = verifyBinding(JSON.parse(row.snapshot));
      const integrity = inspectSessionFile(
        session.file,
        session.piSessionId,
        Boolean(session.known),
      );
      if (!['draft', 'persisted'].includes(integrity.state))
        throw new Error(integrity.error ?? '历史无法读取');
      if (integrity.state === 'persisted') {
        const entries = readFileSync(session.file, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        if (
          entries.some(
            (entry) =>
              entry.type === 'custom' &&
              entry.customType === 'data_agent.agent_config' &&
              (entry.data?.fingerprint !== binding.fingerprint ||
                entry.data?.revision !== binding.revision),
          )
        )
          throw new Error('会话 JSONL 与 SQLite 中的 Agent 配置不一致');
      }
      return binding;
    }
    const integrity = inspectSessionFile(session.file, session.piSessionId, Boolean(session.known));
    if (!['draft', 'persisted'].includes(integrity.state))
      throw new Error(integrity.error ?? '历史无法读取');
    // A draft without model context has no historical behavior to preserve.
    if (integrity.state === 'draft') {
      this.bindNew(id);
      return this.current();
    }
    const binding = this.recoverLegacy(session.file);
    materializeSkills(this.resourcesRoot, binding);
    this.db
      .prepare('UPDATE sessions SET agent_config_override=? WHERE id=?')
      .run(JSON.stringify(binding), id);
    return binding;
  }
  private recoverLegacy(file: string): AgentBinding {
    const entries = readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => JSON.parse(line));
    if (
      entries.some(
        (entry) => entry.type === 'custom' && entry.customType === 'data_agent.agent_config',
      )
    )
      throw new Error('会话配置绑定缺失，请恢复 SQLite 备份');
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    const branch = [];
    for (let entry = entries.at(-1); entry; entry = byId.get(entry.parentId)) branch.unshift(entry);
    const sections: Record<string, string> = {};
    const names = new Set<string>();
    for (const entry of branch)
      if (entry.type === 'message' && entry.message.role === 'system') {
        if (entry.message.content) throw new Error('历史使用了无法识别的系统提示词格式');
        Object.assign(sections, entry.message.sections);
        for (const tool of entry.message.toolsAdded ?? []) names.add(tool.name);
        for (const name of entry.message.toolsRemoved ?? []) names.delete(name);
      }
    const cwd = sections.cwd?.match(/^<cwd>\n([\s\S]*)\n<\/cwd>$/)?.[1];
    if (
      !cwd ||
      sections.preamble !== composeAgentPrompt(cwd, defaultAgentConfig) ||
      JSON.stringify([...names]) !== JSON.stringify(toolIds)
    )
      throw new Error('无法确认历史提示词或工具集合，未套用当前默认配置');
    const location = sections.skills
      ?.match(/<location>(.*?)<\/location>/)?.[1]
      ?.replace(/&apos;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
    const skill = this.bundled[0];
    if (
      !location ||
      !existsSync(location) ||
      configDigest(readFileSync(location, 'utf8')) !== skill.sha256 ||
      (sections.skills.match(/<skill>/g)?.length ?? 0) !== 1
    )
      throw new Error('无法确认历史内置 skill 内容，请保留历史并新建会话');
    return this.build(defaultAgentConfig, [{ ...skill, filePath: location }], sections.preamble);
  }
}
