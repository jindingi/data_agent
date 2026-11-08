import { afterEach, expect, it, vi } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { loadBundledSkills } from '../../../src/node/bundled-skills';
import {
  configDigest,
  materializeSkills,
  verifyBinding,
} from '../../../src/node/agent-config-resources';
import {
  composeAgentPrompt,
  agentConfigSchema,
  defaultAgentConfig,
  normalizeAgentConfig,
} from '../../../src/shared/agent-config';
import { previewAgentPrompt } from '../../../src/agent/prompt-preview';

// Register new trusted built-ins at the same data seam used by the packaged application.
vi.mock('../../../resources/skills/catalog.json', async (importOriginal) => ({
  default: {
    ...(await importOriginal<{ default: object }>()).default,
    'synthetic-workflow': { label: '合成工作流', references: ['guide.md'], runtimeAssets: [] },
    'synthetic-text': { label: '合成文本', references: [], runtimeAssets: [] },
  },
}));
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

it('loads additional skills with their own resources and exposes them through the real SDK preview', async () => {
  const root = mkdtempSync(join(tmpdir(), 'skill-catalog-'));
  roots.push(root);
  const directory = join(root, 'skills');
  cpSync('resources/skills', directory, { recursive: true });
  for (const name of ['synthetic-workflow', 'synthetic-text']) {
    mkdirSync(join(directory, name, 'references'), { recursive: true });
    writeFileSync(
      join(directory, name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Use for ${name} tasks.\n---\n\nInstructions for ${name}.\n`,
    );
  }
  writeFileSync(
    join(directory, 'synthetic-workflow/references/guide.md'),
    'Independent reference.',
  );
  const bundle = loadBundledSkills(
    join(root, 'cache'),
    directory,
    resolve('runtime/report-runtime'),
  );
  expect(
    agentConfigSchema.safeParse({ ...defaultAgentConfig, enabledSkills: ['unregistered'] }).success,
  ).toBe(false);
  for (const skill of bundle.skills.slice(2)) {
    const config = normalizeAgentConfig({ ...defaultAgentConfig, enabledSkills: [skill.id] });
    const contents = { config, skills: [skill] };
    const binding = verifyBinding({
      ...contents,
      revision: 1,
      createdAt: 'fixture',
      fingerprint: configDigest(contents),
    });
    materializeSkills(join(root, 'cache'), binding);
    expect(readFileSync(skill.filePath, 'utf8')).toBe(skill.content);
    expect(skill.assets?.some((asset) => asset.path.startsWith('vendor/')) ?? false).toBe(false);
    const preamble = composeAgentPrompt('/workspace', config);
    expect(preamble).toBe(composeAgentPrompt('/workspace', { ...config, enabledSkills: [] }));
    const preview = await previewAgentPrompt(binding, '/workspace');
    expect(preview.text).toContain(`<name>${skill.name}</name>`);
    expect(preview.text).toContain(skill.description);
    expect(preview.text).not.toContain('<name>data-analysis</name>');
    expect(preview.text).not.toContain('<name>interactive-report</name>');
  }
  const workflow = bundle.skills[2];
  expect(readFileSync(join(dirname(workflow.filePath), 'references/guide.md'), 'utf8')).toBe(
    'Independent reference.',
  );
  expect(bundle.skills[3].assets).toBeUndefined();
});
