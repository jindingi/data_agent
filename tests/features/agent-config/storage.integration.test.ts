import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { openDatabase } from '../../../src/main/storage/database';
import { AgentConfigService } from '../../../src/main/services/agent-config';
import { SessionService } from '../../../src/main/services/sessions';
import { ensureAppPaths, getAppPaths } from '../../../src/node/app-paths';
import { defaultAgentConfig, composeAgentPrompt } from '../../../src/shared/agent-config';
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
it('agent-config.revisions pins saved defaults and rolls back failed resource revisions', () => {
  const { db, paths, configs, sessions } = fixture();
  const current = configs.current();
  expect(current.config.enabledSkills).toEqual(['data-analysis', 'interactive-report']);
  const limited = configs.save({ ...current.config, enabledSkills: ['data-analysis'] }, 1).current;
  const installed = new AgentConfigService(db, paths, resolve('resources/skills'));
  const firstSession = sessions.create();
  expect(installed.current()).toEqual(limited);
  expect(installed.preview(limited.config, 2)).toEqual(limited);
  expect(installed.save(limited.config, 2).current).toEqual(limited);
  db.exec(
    "CREATE TRIGGER reject_revision BEFORE INSERT ON agent_config_revisions BEGIN SELECT RAISE(ABORT,'fixture-failure'); END;",
  );
  expect(() => installed.save(current.config, 2)).toThrow('fixture-failure');
  expect(installed.current()).toEqual(limited);
  db.exec('DROP TRIGGER reject_revision');
  const next = installed.save(current.config, 2).current;
  expect(next).not.toHaveProperty('promptVersion');
  expect(next).not.toHaveProperty('legacyPreamble');
  expect(next.revision).toBe(3);
  expect(installed.require(firstSession.id)).toEqual(limited);
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
it('agent-config.binding rejects missing, outdated and conflicting bindings without changing history', () => {
  const { db, configs, sessions, root } = fixture();
  const draft = sessions.create();
  db.prepare('UPDATE sessions SET agent_config_revision=NULL WHERE id=?').run(draft.id);
  expect(configs.details(draft.id).error).toContain('绑定缺失');
  expect(
    db.prepare('SELECT agent_config_revision AS revision FROM sessions WHERE id=?').get(draft.id),
  ).toEqual({ revision: null });
  const session = sessions.create();
  const initial = configs.require(session.id);
  const manager = SessionManager.open(session.sessionFile, root, session.workspace);
  manager.appendMessage({
    role: 'system',
    content: '',
    sections: {
      preamble: composeAgentPrompt(session.workspace, initial.config),
      skills: `<skills>\n${formatSkillsForPrompt(configuredSkills(initial)).trim()}\n</skills>`,
      cwd: `<cwd>\n${session.workspace}\n</cwd>`,
    },
    toolsAdded: tools.map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    })),
    timestamp: Date.now(),
  });
  bindAgentConfiguration(manager, initial, session.workspace, tools);
  manager.appendMessage({ role: 'user', content: 'History', timestamp: Date.now() });
  const before = readFileSync(session.sessionFile, 'utf8');
  const snapshot = db
    .prepare('SELECT snapshot FROM agent_config_revisions WHERE revision=1')
    .get() as { snapshot: string };
  db.prepare('UPDATE sessions SET agent_config_revision=NULL WHERE id=?').run(session.id);
  expect(configs.details(session.id).error).toContain('绑定缺失');
  expect(() => configs.require(session.id)).toThrow('配置待确认');
  db.prepare('UPDATE sessions SET agent_config_revision=1 WHERE id=?').run(session.id);
  const contents = {
    config: { ...initial.config, systemPrompt: 'Changed' },
    skills: initial.skills,
  };
  db.prepare('UPDATE agent_config_revisions SET snapshot=? WHERE revision=1').run(
    JSON.stringify({ ...initial, ...contents, fingerprint: configDigest(contents) }),
  );
  expect(configs.details(session.id).error).toContain('不一致');
  db.prepare('UPDATE agent_config_revisions SET snapshot=? WHERE revision=1').run(
    JSON.stringify({ ...initial, promptVersion: 2 }),
  );
  expect(() => configs.require(session.id)).toThrow('配置待确认');
  db.prepare('UPDATE agent_config_revisions SET snapshot=? WHERE revision=1').run(
    snapshot.snapshot,
  );
  expect(configs.require(session.id)).toEqual(initial);
  expect(readFileSync(session.sessionFile, 'utf8')).toBe(before);
});
it('agent-config.resources keeps frozen skill bodies until an explicit disable and re-enable', () => {
  const { db, paths, configs, sessions, root } = fixture();
  const first = sessions.create();
  const initial = configs.require(first.id);
  const bundle = join(root, 'changed-skills');
  mkdirSync(bundle, { recursive: true });
  cpSync('resources/skills', bundle, { recursive: true });
  const changed = initial.skills[0].content + '\nNew guidance.\n';
  writeFileSync(join(bundle, 'data-analysis/SKILL.md'), changed);
  const upgraded = new AgentConfigService(db, paths, bundle, resolve('runtime/report-runtime'));
  expect(upgraded.current()).toEqual(initial);
  expect(upgraded.require(first.id)).toEqual(initial);
  const disabled = upgraded.save(
    { ...initial.config, enabledSkills: ['interactive-report'] },
    1,
  ).current;
  const enabled = upgraded.save(initial.config, disabled.revision!).current;
  expect(enabled.skills[0].content).toBe(changed);
  expect(upgraded.require(first.id)).toEqual(initial);
});
