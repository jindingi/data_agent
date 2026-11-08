import { readFileSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import {
  bundledSkillCatalog,
  skillAssetSchema,
  skillIds,
  type AgentBinding,
} from '../shared/agent-config';
import { configDigest, frozenSkillPath } from './agent-config-resources';
import lock from '../../resources/echarts-lock.json';

/** Only these application-owned resources may enter immutable configuration snapshots. */
export function loadBundledSkills(root: string, directory: string, runtime: string) {
  const binarySources = new Map<string, string>();
  const skills = skillIds.map((id): AgentBinding['skills'][number] => {
    const definition = bundledSkillCatalog[id];
    const content = readFileSync(join(directory, id, 'SKILL.md'), 'utf8');
    const description = content.match(/^description: (.+)$/m)?.[1];
    if (!description || !content.startsWith(`---\nname: ${id}\n`))
      throw new Error('内置 skill 元数据无效');
    const sha256 = configDigest(content);
    const assets = definition.references.map((name) => {
      const path = `references/${name}`;
      skillAssetSchema.shape.path.parse(path);
      const text = readFileSync(join(directory, id, 'references', name), 'utf8');
      return {
        path,
        content: text,
        sha256: configDigest(text),
        bytes: Buffer.byteLength(text),
      };
    });
    const vendor = definition.runtimeAssets.map((name) => {
      const path = `vendor/${name}`;
      skillAssetSchema.shape.path.parse(path);
      if (!Object.hasOwn(lock.files, name)) throw new Error('内置运行时资源未锁定');
      const item = lock.files[name as keyof typeof lock.files];
      const file = join(runtime, name);
      // Missing installation bytes must not prevent browsing existing reports.
      // A session can use its verified cache; materialization rejects any missing hash.
      try {
        const stat = lstatSync(file);
        if (
          stat.isFile() &&
          stat.size === item.bytes &&
          configDigest(readFileSync(file, 'utf8')) === item.sha256
        )
          binarySources.set(item.sha256, file);
      } catch (error) {
        if (!['ENOENT', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? ''))
          throw error;
      }
      return { path, sha256: item.sha256, bytes: item.bytes };
    });
    const all = [...assets, ...vendor]
      .map((asset) => skillAssetSchema.parse(asset))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const bundleHash = all.length ? configDigest({ sha256, assets: all }) : undefined;
    return {
      id,
      name: id,
      description,
      content,
      sha256,
      filePath: frozenSkillPath(root, bundleHash ?? sha256, id),
      ...(bundleHash ? { bundleHash, assets: all } : {}),
    };
  });
  return { skills, binarySources };
}
