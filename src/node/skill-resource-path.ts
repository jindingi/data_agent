import { dirname, join, resolve } from 'node:path';
import type { AgentBinding } from '../shared/agent-config';
import { frozenSkillPath } from './agent-config-resources';

/** Resolve only exact files declared in the immutable binding, never arbitrary old paths. */
export function skillResourcePath(
  binding: AgentBinding,
  root: string,
  requested: string,
  cwd: string,
): string | undefined {
  const path = resolve(cwd, requested);
  for (const skill of binding.skills) {
    const local = frozenSkillPath(root, skill.bundleHash ?? skill.sha256, skill.id);
    if (path === skill.filePath) return local;
    for (const asset of skill.assets ?? [])
      if (path === join(dirname(skill.filePath), asset.path))
        return join(dirname(local), asset.path);
  }
}
