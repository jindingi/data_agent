import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, lstatSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { agentBindingSchema, type AgentBinding } from '../shared/agent-config';
export function configDigest(value: unknown): string {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
}
export function verifyBinding(value: unknown): AgentBinding {
  const binding = agentBindingSchema.parse(value);
  const { fingerprint, config, skills, promptVersion, legacyPreamble } = binding;
  const contents = {
    config,
    skills,
    promptVersion,
    ...(legacyPreamble === undefined ? {} : { legacyPreamble }),
  };
  if (
    configDigest(contents) !== fingerprint ||
    binding.skills.some((s) => configDigest(s.content) !== s.sha256) ||
    JSON.stringify(binding.skills.map((s) => s.id)) !== JSON.stringify(binding.config.enabledSkills)
  )
    throw new Error('Agent 配置快照校验失败');
  return binding;
}
/** Materialize only trusted, hashed bundled text. Never accepts a Renderer-supplied path. */
export function materializeSkills(root: string, binding: AgentBinding) {
  for (const skill of binding.skills) {
    const file = frozenSkillPath(root, skill.sha256, skill.id);
    // Refuse symlinks at every cache component, including existing parent directories.
    for (let path = file; path !== dirname(root); path = dirname(path)) {
      if (existsSync(path) && lstatSync(path).isSymbolicLink())
        throw new Error('内置 skill 快照路径不可为符号链接');
      if (path === root) break;
    }
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    if (existsSync(file)) {
      if (configDigest(readFileSync(file, 'utf8')) !== skill.sha256)
        throw new Error('内置 skill 快照已被修改');
    } else writeFileSync(file, skill.content, { flag: 'wx', mode: 0o400 });
  }
}
export function frozenSkillPath(root: string, hash: string, id: string) {
  return join(root, hash, 'resources/skills', id, 'SKILL.md');
}
