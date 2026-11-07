import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { openDatabase } from '../../../src/main/storage/database';
import { AgentConfigService } from '../../../src/main/services/agent-config';
import { SessionService } from '../../../src/main/services/sessions';
import { ensureAppPaths, getAppPaths } from '../../../src/node/app-paths';
import { defaultAgentConfig, composeAgentPrompt, toolIds } from '../../../src/shared/agent-config';
import { genericTools } from '../../../src/agent/tools';
import { configuredSkills, bindAgentConfiguration } from '../../../src/agent/agent-configuration';
import { formatSkillsForPrompt } from '@earendil-works/pi-coding-agent';
import { PolicyService } from '../../../src/main/services/policy';
import { getRuntimePaths } from '../../../src/node/runtime-paths';
import { configDigest } from '../../../src/node/agent-config-resources';

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agent-config-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const paths = getAppPaths(
    { DATA_AGENT_HOME: join(root, 'data'), DATA_AGENT_USER_DATA: join(root, 'user') },
    true,
  );
  ensureAppPaths(paths);
  const db = openDatabase(paths.database);
  cleanups.push(() => db.close());
  const configs = new AgentConfigService(db, paths, resolve('resources/skills'));
  const sessions = new SessionService(db, paths, undefined, configs);
  return { root, paths, db, configs, sessions };
}
const tools = genericTools(
  { execute: async () => ({ output: 'ok', isError: false }), subscribe: () => () => {} },
  (value) => value,
);
it('agent-config.report-migration preserves installed protocol-1 defaults and rolls back failed resource revisions', () => {
  const { db, paths, configs, sessions } = fixture();
  const current = configs.current();
  expect(current.config.enabledSkills).toEqual(['data-analysis', 'interactive-report']);
  const contents = {
    config: defaultAgentConfig,
    skills: [current.skills[0]],
    promptVersion: 1 as const,
  };
  const old = { ...current, ...contents, fingerprint: configDigest(contents) };
  db.prepare('UPDATE agent_config_revisions SET snapshot=? WHERE revision=1').run(
    JSON.stringify(old),
  );
  const installed = new AgentConfigService(db, paths, resolve('resources/skills'));
  const oldSession = sessions.create();
  expect(installed.current()).toEqual(old);
  expect(installed.settings().availableSkills.map((s) => s.id)).toEqual([
    'data-analysis',
    'interactive-report',
  ]);
  expect(installed.preview(old.config, 1)).toEqual(old);
  expect(installed.save(old.config, 1).current).toEqual(old);
  db.exec(
    "CREATE TRIGGER reject_revision BEFORE INSERT ON agent_config_revisions BEGIN SELECT RAISE(ABORT,'fixture-failure'); END;",
  );
  expect(() => installed.save(current.config, 1)).toThrow('fixture-failure');
  expect(installed.current()).toEqual(old);
  db.exec('DROP TRIGGER reject_revision');
  const next = installed.save(current.config, 1).current;
  expect(next.promptVersion).toBe(2);
  expect(next.revision).toBe(2);
  expect(installed.require(oldSession.id)).toEqual(old);
  expect(installed.require(sessions.create().id)).toEqual(next);
});
it('agent-config.storage pins immutable versions, rolls back creation and restores missing resources', async () => {
  const { paths, db, configs, sessions } = fixture();
  const first = sessions.create();
  const v1 = configs.require(first.id);
  expect(v1.revision).toBe(1);
  const v2 = configs.save(
    { ...defaultAgentConfig, systemPrompt: 'Be concise.', enabledSkills: [], enabledTools: [] },
    1,
  );
  expect(v2.current.revision).toBe(2);
  expect(configs.require(first.id)).toEqual(v1);
  expect(configs.save(v2.current.config, 2).current.revision).toBe(2);
  expect(() => configs.save(v2.current.config, 1)).toThrow('更新');
  const second = sessions.create();
  expect(configs.require(second.id).revision).toBe(2);
  expect(() => configs.save({ ...defaultAgentConfig, enabledTools: [] }, 2)).toThrow('read');
  const previous = db.prepare('SELECT count(*) n FROM sessions').get();
  db.exec(
    "CREATE TRIGGER fail_binding BEFORE UPDATE OF agent_config_revision ON sessions BEGIN SELECT RAISE(ABORT,'fixture'); END;",
  );
  expect(() => sessions.create()).toThrow('fixture');
  expect(db.prepare('SELECT count(*) n FROM sessions').get()).toEqual(previous);
  db.exec('DROP TRIGGER fail_binding');
  rmSync(v1.skills[0].filePath);
  configs.require(first.id);
  expect(readFileSync(v1.skills[0].filePath, 'utf8')).toBe(v1.skills[0].content);
  const reopened = new AgentConfigService(db, paths, resolve('resources/skills'));
  expect(reopened.current()).toEqual(v2.current);
  const policy = new PolicyService(getRuntimePaths(process.cwd(), '', false));
  const context = {
    workspace: first.workspace,
    protectedRoots: [],
    inputs: [],
    readonlyRoots: [configs.resourcesRoot],
  };
  expect(
    (await policy.inspect(context, { name: 'read', path: v1.skills[0].filePath })).decision,
  ).toBe('allow');
  expect(
    (
      await policy.inspect(context, {
        name: 'write',
        path: v1.skills[0].filePath,
        content: 'change',
      })
    ).decision,
  ).toBe('deny');
  expect(
    (await policy.inspect(context, { name: 'bash', command: `rm -rf '${configs.resourcesRoot}'` }))
      .decision,
  ).toBe('deny');
});
it('agent-config.legacy restores verified historical state and blocks missing or conflicting bindings', () => {
  const { db, configs, sessions, root } = fixture();
  const session = sessions.create();
  const initial = configs.require(session.id);
  const manager = SessionManager.open(session.sessionFile, root, session.workspace);
  const legacySkill = {
    ...initial.skills[0],
    filePath: resolve('resources/skills/data-analysis/SKILL.md'),
  };
  const skills = configuredSkills({ ...initial, skills: [legacySkill] });
  manager.appendMessage({
    role: 'system',
    content: '',
    sections: {
      preamble: composeAgentPrompt(session.workspace, defaultAgentConfig),
      skills: `<skills>\n${formatSkillsForPrompt(skills).trim()}\n</skills>`,
      cwd: `<cwd>\n${session.workspace}\n</cwd>`,
    },
    toolsAdded: tools.map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    })),
    timestamp: Date.now(),
  });
  manager.appendMessage({ role: 'user', content: 'History', timestamp: Date.now() });
  db.prepare(
    'UPDATE sessions SET agent_config_revision=NULL,agent_config_override=NULL WHERE id=?',
  ).run(session.id);
  configs.save(
    { ...defaultAgentConfig, systemPrompt: 'New default', enabledTools: [], enabledSkills: [] },
    1,
  );
  const legacy = configs.require(session.id);
  expect(legacy.revision).toBeNull();
  expect(legacy.config.enabledTools).toEqual(toolIds);
  expect(legacy.legacyPreamble).toBe(composeAgentPrompt(session.workspace, defaultAgentConfig));
  const before = readFileSync(session.sessionFile, 'utf8');
  bindAgentConfiguration(manager, legacy, session.workspace, tools);
  expect(() => bindAgentConfiguration(manager, configs.current(), session.workspace, [])).toThrow(
    '不一致',
  );
  const stored = JSON.stringify(legacy);
  const altered = { ...legacy, revision: 99 };
  db.prepare(
    'UPDATE sessions SET agent_config_revision=NULL,agent_config_override=? WHERE id=?',
  ).run(JSON.stringify(altered), session.id);
  expect(configs.details(session.id).error).toContain('不一致');
  db.prepare(
    'UPDATE sessions SET agent_config_revision=NULL,agent_config_override=? WHERE id=?',
  ).run(stored, session.id);
  // Missing DB binding with an existing JSONL identity must not silently migrate or adopt defaults.
  db.prepare(
    'UPDATE sessions SET agent_config_revision=NULL,agent_config_override=NULL WHERE id=?',
  ).run(session.id);
  expect(configs.details(session.id).error).toContain('绑定缺失');
  expect(() => configs.require(session.id)).toThrow('配置待确认');
  expect(readFileSync(session.sessionFile, 'utf8').startsWith(before)).toBe(true);
  const unknown = sessions.create();
  db.prepare(
    'UPDATE sessions SET agent_config_revision=NULL,agent_config_override=NULL WHERE id=?',
  ).run(unknown.id);
  const damaged = SessionManager.open(unknown.sessionFile, root, unknown.workspace);
  damaged.appendMessage({
    role: 'system',
    content: '',
    sections: { preamble: 'unknown' },
    timestamp: Date.now(),
  });
  damaged.appendMessage({ role: 'user', content: 'Historical prompt', timestamp: Date.now() });
  expect(configs.details(unknown.id).binding).toBeNull();
  expect(configs.details(unknown.id).error).toContain('无法确认');
  // A changed bundled resource becomes a new revision only when explicitly saved.
  const bundle = join(root, 'changed-skills');
  mkdirSync(join(bundle, 'data-analysis'), { recursive: true });
  cpSync('resources/skills/interactive-report', join(bundle, 'interactive-report'), {
    recursive: true,
  });
  writeFileSync(join(bundle, 'data-analysis/SKILL.md'), legacySkill.content + '\nNew guidance.\n');
  const upgraded = new AgentConfigService(
    db,
    { home: join(root, 'data'), workspace: '', sessions: '', logs: '', database: '' },
    bundle,
    resolve('runtime/report-runtime'),
  );
  expect(upgraded.current().revision).toBe(2);
});
