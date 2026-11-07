import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  lstatSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
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
    binding.skills.some(
      (s) =>
        configDigest(s.content) !== s.sha256 ||
        !!s.assets !== !!s.bundleHash ||
        (s.assets &&
          (binding.promptVersion !== 2 ||
            configDigest({ sha256: s.sha256, assets: s.assets }) !== s.bundleHash ||
            new Set(s.assets.map((a) => a.path)).size !== s.assets.length ||
            s.assets.some(
              (a) =>
                a.content !== undefined &&
                (configDigest(a.content) !== a.sha256 || Buffer.byteLength(a.content) !== a.bytes),
            ))),
    ) ||
    JSON.stringify(binding.skills.map((s) => s.id)) !== JSON.stringify(binding.config.enabledSkills)
  )
    throw new Error('Agent 配置快照校验失败');
  return binding;
}
/** Materialize only trusted, hashed bundled text. Never accepts a Renderer-supplied path. */
export function materializeSkills(
  root: string,
  binding: AgentBinding,
  binarySources = new Map<string, string>(),
) {
  const put = (file: string, sha256: string, content: string | undefined, bytes?: number) => {
    for (let path = file; path !== dirname(root); path = dirname(path)) {
      try {
        if (lstatSync(path).isSymbolicLink()) throw new Error('内置 skill 快照路径不可为符号链接');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (path === root) break;
    }
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    if (existsSync(file)) {
      const stat = lstatSync(file);
      if (
        !stat.isFile() ||
        stat.size > 16 * 1024 * 1024 ||
        (bytes !== undefined && stat.size !== bytes) ||
        configDigest(readFileSync(file, 'utf8')) !== sha256
      )
        throw new Error('内置 skill 快照已被修改');
      return;
    }
    const source = binarySources.get(sha256);
    const text = content ?? (source ? readFileSync(source, 'utf8') : undefined);
    if (
      text === undefined ||
      configDigest(text) !== sha256 ||
      (bytes !== undefined && Buffer.byteLength(text) !== bytes)
    )
      throw new Error('配置资源缺失，无法从相同版本恢复');
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, text, { flag: 'wx', mode: 0o400 });
      renameSync(temp, file);
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
  };
  for (const skill of binding.skills) {
    const file = frozenSkillPath(root, skill.bundleHash ?? skill.sha256, skill.id);
    put(file, skill.sha256, skill.content);
    for (const asset of skill.assets ?? [])
      put(join(dirname(file), asset.path), asset.sha256, asset.content, asset.bytes);
  }
}
export function frozenSkillPath(root: string, hash: string, id: string) {
  return join(root, hash, 'resources/skills', id, 'SKILL.md');
}
