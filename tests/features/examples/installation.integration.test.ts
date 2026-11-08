import { afterEach, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  rmSync,
  existsSync,
  symlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { openDatabase, migrate } from '../../../src/main/storage/database';
import { getAppPaths, ensureAppPaths } from '../../../src/node/app-paths';
import { configDigest } from '../../../src/node/agent-config-resources';
import { defaultAgentConfig } from '../../../src/shared/agent-config';
import { readExampleBundle, exampleHash } from '../../../src/node/example-bundle';
import { AgentConfigService } from '../../../src/main/services/agent-config';
import { ExampleService } from '../../../src/main/services/examples';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'example-install-')));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const bundle = join(root, 'bundle');
  mkdirSync(bundle);
  const files: Record<string, { bytes: number; sha256: string }> = {};
  const put = (path: string, text: string) => {
    const file = join(bundle, path);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, text);
    const bytes = Buffer.from(text);
    files[path] = { bytes: bytes.length, sha256: exampleHash(bytes) };
  };
  const config = { ...defaultAgentConfig, enabledTools: [], enabledSkills: [] };
  const binding = {
    config,
    skills: [],
    fingerprint: configDigest({ config, skills: [] }),
    revision: 2,
    createdAt: new Date().toISOString(),
  };
  const examples = [0, 1].map((i) => {
    const id = randomUUID(),
      pi = randomUUID(),
      input = randomUUID(),
      runId = randomUUID(),
      entryId = 'user1';
    const directory = `example-${i}`,
      report = i ? 'report.html' : 'report.md',
      createdAt = new Date().toISOString();
    put(
      `${directory}/session.jsonl`,
      [
        {
          type: 'session',
          version: 3,
          id: pi,
          cwd: '/private/tmp/example-author/workspace',
          timestamp: createdAt,
        },
        {
          type: 'custom',
          id: 'config',
          parentId: null,
          timestamp: createdAt,
          customType: 'data_agent.agent_config',
          data: { revision: 2, fingerprint: binding.fingerprint },
        },
        {
          type: 'message',
          id: entryId,
          parentId: 'config',
          timestamp: createdAt,
          message: { role: 'user', content: `[data-agent-input:${input}]\nSynthetic example.` },
        },
      ]
        .map((e) => JSON.stringify(e))
        .join('\n') + '\n',
    );
    put(`${directory}/agent-binding.json`, JSON.stringify(binding));
    put(
      `${directory}/workspace/${report}`,
      i ? '<!doctype html><h1>Synthetic HTML</h1>' : '# Synthetic report',
    );
    put(`${directory}/workspace/analysis.py`, 'print("synthetic")\n');
    return {
      id,
      title: `Synthetic example ${i}`,
      directory,
      report,
      runId,
      createdAt,
      inputs: [{ inputId: input, runId, entryId, kind: 'prompt', digest: 'a'.repeat(64) }],
    };
  });
  put('datasets/netflix/netflix_titles.csv', 'show_id,type\ns1,Movie\n');
  put('datasets/netflix/SOURCE.md', 'Synthetic fixture, not real Netflix data.');
  writeFileSync(join(bundle, 'catalog.json'), JSON.stringify({ version: 1, files, examples }));
  const paths = getAppPaths({ DATA_AGENT_HOME: join(root, 'data') }, false);
  ensureAppPaths(paths);
  const db = openDatabase(paths.database);
  cleanup.push(() => db.close());
  const configs = new AgentConfigService(
    db,
    paths,
    resolve('resources/skills'),
    resolve('runtime/report-runtime'),
  );
  return { root, bundle, paths, db, configs, examples };
}
it('examples.installation imports ordinary writable sessions once and preserves deletion, edits and defaults', () => {
  const f = fixture(),
    service = new ExampleService(f.db, f.paths, f.bundle, f.configs);
  const before = f.configs.current();
  expect(service.install().sessions).toHaveLength(2);
  expect(f.configs.current().fingerprint).toBe(before.fingerprint);
  expect(f.configs.current().revision).toBe(3);
  for (const e of f.examples) {
    expect(f.configs.require(e.id).revision).toBe(2);
    expect(
      readFileSync(join(f.paths.workspace, e.id, 'data/netflix_titles.csv'), 'utf8'),
    ).toContain('s1');
  }
  const id = f.examples[0].id;
  writeFileSync(join(f.paths.workspace, id, 'report.md'), 'user edits');
  f.db.prepare('DELETE FROM sessions WHERE id=?').run(id);
  expect(new ExampleService(f.db, f.paths, f.bundle, f.configs).install().sessions).toHaveLength(1);
  expect(readFileSync(join(f.paths.workspace, id, 'report.md'), 'utf8')).toBe('user edits');
  expect(f.db.prepare('SELECT * FROM input_submissions WHERE session_id=?').all(id)).toHaveLength(
    0,
  );
});
it('examples.recovery restores interrupted installs without exposing partial sessions', () => {
  for (const point of ['staged', 'published', 'before-commit', 'in-commit']) {
    const f = fixture();
    let failed = false;
    const service = new ExampleService(f.db, f.paths, f.bundle, f.configs, {
      at(p) {
        if (p === point && !failed) {
          failed = true;
          throw new Error('injected crash');
        }
      },
    });
    expect(service.install().error).toContain('injected crash');
    expect(f.db.prepare('SELECT * FROM sessions').all()).toHaveLength(0);
    expect(f.configs.current().revision).toBe(1);
    const restored = new ExampleService(f.db, f.paths, f.bundle, f.configs).install();
    expect(restored.error).toBeUndefined();
    expect(restored.sessions).toHaveLength(2);
  }
});
it('examples.resource-safety rejects corrupt bundles, linked targets and changed partial files', () => {
  const f = fixture(),
    e = f.examples[0];
  const target = join(f.paths.workspace, e.id);
  mkdirSync(target);
  writeFileSync(join(target, 'report.md'), 'owned by user');
  expect(new ExampleService(f.db, f.paths, f.bundle, f.configs).install().error).toContain(
    '不同内容',
  );
  expect(readFileSync(join(target, 'report.md'), 'utf8')).toBe('owned by user');
  rmSync(join(target, 'report.md'));
  symlinkSync('/private/tmp', join(target, 'report.md'));
  expect(new ExampleService(f.db, f.paths, f.bundle, f.configs).install().error).toBeTruthy();
  writeFileSync(join(f.bundle, e.directory, 'workspace', e.report), 'corrupt');
  expect(() => readExampleBundle(f.bundle)).toThrow('大小');
  expect(f.db.prepare('SELECT * FROM sessions').all()).toHaveLength(0);
});
it('examples.existing-install marks existing databases skipped even when they contain no sessions', () => {
  const f = fixture();
  const path = join(f.root, 'existing.sqlite');
  const existing = new Database(path);
  migrate(existing);
  existing.close();
  const db = openDatabase(path);
  try {
    expect(
      JSON.parse(
        (
          db
            .prepare("SELECT value FROM app_metadata WHERE key='examples.initialization'")
            .get() as { value: string }
        ).value,
      ).state,
    ).toBe('skipped');
    expect(existsSync(join(f.paths.workspace, f.examples[0].id))).toBe(false);
  } finally {
    db.close();
  }
});
