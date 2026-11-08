import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { loadBundledSkills } from '../../../src/node/bundled-skills';
import {
  configDigest,
  materializeSkills,
  verifyBinding,
} from '../../../src/node/agent-config-resources';
import { defaultAgentConfig, type AgentBinding } from '../../../src/shared/agent-config';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'report-resources-'));
  roots.push(root);
  const bundle = loadBundledSkills(
    root,
    resolve('resources/skills'),
    resolve('runtime/report-runtime'),
  );
  const contents = {
    config: defaultAgentConfig,
    skills: bundle.skills,
  };
  const binding: AgentBinding = {
    ...contents,
    revision: 1,
    createdAt: 'fixture',
    fingerprint: configDigest(contents),
  };
  return { root, bundle, binding };
}
it('freezes skill resources across recovery without prompt protocol versions', () => {
  const { root, bundle, binding } = fixture();
  expect(() => verifyBinding({ ...binding, promptVersion: 1 })).toThrow();
  expect(() => verifyBinding({ ...binding, legacyPreamble: 'Old prompt' })).toThrow();
  verifyBinding(binding);
  materializeSkills(root, binding, bundle.binarySources);
  const skill = binding.skills[1];
  const base = dirname(skill.filePath);
  const library = readFileSync(join(base, 'vendor/echarts.min.js'));
  rmSync(join(base, 'references/echarts.md'));
  materializeSkills(root, binding); // small text restores from snapshot, library from existing cache
  expect(readFileSync(join(base, 'references/echarts.md'), 'utf8')).toContain('ECharts');
  expect(readFileSync(join(base, 'vendor/echarts.min.js'))).toEqual(library);
  const missingInstallation = loadBundledSkills(
    root,
    resolve('resources/skills'),
    join(root, 'missing-installation'),
  );
  expect(missingInstallation.skills).toEqual(bundle.skills);
  expect(missingInstallation.binarySources.size).toBe(0);
  materializeSkills(root, binding, missingInstallation.binarySources);
  rmSync(join(base, 'vendor/echarts.min.js'));
  expect(() => materializeSkills(root, binding)).toThrow('缺失');
  materializeSkills(root, binding, bundle.binarySources);
  expect(readFileSync(join(base, 'vendor/echarts.min.js'))).toEqual(library);
});
it('rejects mutated descriptors, bytes and symlinks without overwriting them', () => {
  const { root, bundle, binding } = fixture();
  const changed = structuredClone(binding);
  changed.skills[1].assets![0].content += 'changed';
  expect(() => verifyBinding(changed)).toThrow('校验');
  materializeSkills(root, binding, bundle.binarySources);
  const file = join(dirname(binding.skills[1].filePath), 'vendor/echarts.min.js');
  rmSync(file);
  writeFileSync(file, 'changed');
  expect(() => materializeSkills(root, binding, bundle.binarySources)).toThrow('修改');
  expect(readFileSync(file, 'utf8')).toBe('changed');
  rmSync(file);
  symlinkSync('/missing-report-resource', file);
  expect(() => materializeSkills(root, binding, bundle.binarySources)).toThrow('符号链接');
});
