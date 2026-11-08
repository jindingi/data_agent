import { loadBundledSkills } from '../../node/bundled-skills';
import type Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppPaths } from '../../node/app-paths';
import { inspectSessionFile } from '../../node/session-integrity';
import { configDigest, materializeSkills, verifyBinding } from '../../node/agent-config-resources';
import { AppError } from '../../shared/errors';
import {
  bundledSkillCatalog,
  defaultAgentConfig,
  normalizeAgentConfig,
  type AgentConfig,
  type AgentBinding,
  type AgentConfigSettings,
  type SessionAgentConfig,
} from '../../shared/agent-config';

/** SQLite owns immutable revisions/bindings. Native JSONL remains the only chat history. */
export class AgentConfigService {
  readonly resourcesRoot: string;
  private bundled: AgentBinding['skills'];
  private binarySources: Map<string, string>;
  constructor(
    private db: Database.Database,
    paths: AppPaths,
    skillsDirectory: string,
    reportRuntime = join(skillsDirectory, '../../runtime/report-runtime'),
  ) {
    this.resourcesRoot = join(paths.home, 'agent-resources');
    const bundle = loadBundledSkills(this.resourcesRoot, skillsDirectory, reportRuntime);
    this.bundled = bundle.skills;
    this.binarySources = bundle.binarySources;
    if (!this.db.prepare('SELECT revision FROM agent_config_revisions LIMIT 1').get())
      this.db.transaction(() => this.insert(defaultAgentConfig))();
  }
  settings(): AgentConfigSettings {
    return {
      current: this.current(),
      defaults: structuredClone(defaultAgentConfig),
      availableSkills: this.editableSkills().map(({ id, name, description, content }) => ({
        id,
        label: bundledSkillCatalog[id].label,
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
      if (JSON.stringify(normalizeAgentConfig(config)) === JSON.stringify(current.config)) return;
      const skills = this.editableSkills().filter((s) => config.enabledSkills.includes(s.id));
      const next = this.build(normalizeAgentConfig(config), skills);
      if (next.fingerprint !== current.fingerprint) this.insert(config, skills);
    })();
    return this.settings();
  }
  preview(config: AgentConfig, expectedRevision: number): AgentBinding {
    const current = this.current();
    if (current.revision !== expectedRevision)
      throw new AppError('CONFIG_CONFLICT', '配置已更新，请重新加载后查看预览');
    if (JSON.stringify(normalizeAgentConfig(config)) === JSON.stringify(current.config))
      return current;
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
  ): AgentBinding {
    const contents = {
      config: normalizeAgentConfig(config),
      skills,
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
    materializeSkills(this.resourcesRoot, binding, this.binarySources);
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
      .prepare('UPDATE sessions SET agent_config_revision=? WHERE id=?')
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
      materializeSkills(this.resourcesRoot, binding, this.binarySources);
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
        'SELECT r.snapshot FROM sessions s LEFT JOIN agent_config_revisions r ON r.revision=s.agent_config_revision WHERE s.id=?',
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
    throw new Error('会话配置绑定缺失，请新建会话');
  }
}
