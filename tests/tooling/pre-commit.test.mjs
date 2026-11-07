import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const repo = resolve(import.meta.dirname, '../..');

test(
  'real Husky commits format staged code, reject lint/syntax errors and preserve unstaged edits',
  { timeout: 120_000 },
  () => {
    const results = join(repo, 'test-results');
    mkdirSync(results, { recursive: true });
    const root = mkdtempSync(join(results, 'pre-commit-'));
    const env = {
      ...process.env,
      HUSKY: '1',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    };
    // Do not inherit a parent commit's index/repository when this test is run by another hook.
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[key];
    function run(command, args, expected = 0) {
      const result = spawnSync(command, args, {
        cwd: root,
        env,
        encoding: 'utf8',
        timeout: 30_000,
      });
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      if (expected === 0) assert.equal(result.status, 0, output);
      else assert.notEqual(result.status, 0, output);
      assert.equal(result.error, undefined);
      return output;
    }
    try {
      mkdirSync(join(root, '.husky'));
      mkdirSync(join(root, 'src/renderer'), { recursive: true });
      for (const file of [
        'eslint.config.mjs',
        'lint-staged.config.mjs',
        '.prettierrc.json',
        '.prettierignore',
        '.husky/pre-commit',
      ]) {
        copyFileSync(join(repo, file), join(root, file));
      }
      symlinkSync(join(repo, 'node_modules'), join(root, 'node_modules'), 'dir');
      writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify(
          {
            private: true,
            type: 'module',
            scripts: {
              lint: 'eslint . --max-warnings=0',
              // This fixture tests the real hook and tools, not the product's type checker.
              check: 'node --check eslint.config.mjs',
            },
          },
          null,
          2,
        ) + '\n',
      );
      run('git', ['init', '-q']);
      run('git', ['config', 'user.name', 'Hook verification']);
      run('git', ['config', 'user.email', 'hook-test@example.invalid']);
      run('git', ['config', 'commit.gpgSign', 'false']);
      run('pnpm', ['exec', 'husky']);
      assert.equal(run('git', ['config', '--get', 'core.hooksPath']).trim(), '.husky/_');
      const file = join(root, 'src/fixture.ts');
      writeFileSync(file, 'export const answer={ value:42 }\n');
      run('git', ['add', '.']);
      run('git', ['commit', '-qm', 'valid staged code is formatted']);
      const formatted = run('git', ['show', 'HEAD:src/fixture.ts']);
      assert.equal(formatted, 'export const answer = { value: 42 };\n');
      const head = run('git', ['rev-parse', 'HEAD']);

      writeFileSync(file, 'const unused = 42;\nexport {};\n');
      run('git', ['add', 'src/fixture.ts']);
      assert.match(run('git', ['commit', '-qm', 'must reject lint error'], 1), /no-unused-vars/);
      assert.equal(run('git', ['rev-parse', 'HEAD']), head);
      assert.match(readFileSync(file, 'utf8'), /const unused/);

      writeFileSync(file, 'export const = ;\n');
      run('git', ['add', 'src/fixture.ts']);
      assert.match(run('git', ['commit', '-qm', 'must reject syntax error'], 1), /Parsing error/);
      assert.equal(run('git', ['rev-parse', 'HEAD']), head);

      writeFileSync(file, 'export const answer={ value:43 }\n');
      run('git', ['add', 'src/fixture.ts']);
      writeFileSync(file, 'export const answer={ value:43 }\n\n// Keep this unstaged note.\n');
      run('git', ['commit', '-qm', 'preserve partial staging']);
      assert.equal(
        run('git', ['show', 'HEAD:src/fixture.ts']),
        'export const answer = { value: 43 };\n',
      );
      assert.match(readFileSync(file, 'utf8'), /Keep this unstaged note/);
      assert.match(run('git', ['diff', '--', 'src/fixture.ts']), /Keep this unstaged note/);

      writeFileSync(
        join(root, 'src/renderer/bad.tsx'),
        "import { useState } from 'react';\nexport function invalid() { return useState(0); }\n",
      );
      run('git', ['add', 'src/renderer/bad.tsx']);
      assert.match(
        run('git', ['commit', '-qm', 'must reject invalid hook'], 1),
        /react-hooks\/rules-of-hooks/,
      );
      run('git', ['rm', '--cached', 'src/renderer/bad.tsx']);
      rmSync(join(root, 'src/renderer/bad.tsx'));

      const currentHead = run('git', ['rev-parse', 'HEAD']);
      writeFileSync(join(root, 'src/bad.js'), 'const unused = 42;\nexport {};\n');
      run('git', ['add', 'src/bad.js']);
      assert.match(run('git', ['commit', '-qm', 'must reject JS lint error'], 1), /no-unused-vars/);
      assert.equal(run('git', ['rev-parse', 'HEAD']), currentHead);
      run('git', ['rm', '--cached', 'src/bad.js']);
      rmSync(join(root, 'src/bad.js'));

      writeFileSync(join(root, 'invalid.json'), '{"broken": }\n');
      run('git', ['add', 'invalid.json']);
      assert.match(
        run('git', ['commit', '-qm', 'must reject formatter parse error'], 1),
        /SyntaxError/,
      );
      assert.equal(run('git', ['rev-parse', 'HEAD']), currentHead);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
