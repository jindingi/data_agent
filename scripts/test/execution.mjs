import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createRunContext, setRunContext, preparePackageDependencies } from './run-context.mjs';
import { verifyRelease } from '../build/verify-release.mjs';

export function sourceFingerprint() {
  const hash = createHash('sha256');
  const files = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean);
  for (const file of [...new Set(files)].sort())
    if (existsSync(file)) hash.update(file).update('\0').update(readFileSync(file)).update('\0');
  return hash.digest('hex');
}
function command(file, args, output, env = process.env) {
  const result = spawnSync(file, args, { encoding: 'utf8', env, maxBuffer: 20 * 1024 * 1024 });
  writeFileSync(output, (result.stdout ?? '') + (result.stderr ?? ''));
  return result;
}
export function prepare(plan, options, dir) {
  const context = createRunContext(options['run-root'] ?? dir);
  setRunContext(context);
  const fingerprint = sourceFingerprint(),
    stamp = join(context.appDir, 'build-source.sha256');
  const run = (id, args) => {
    const result = command('pnpm', args, join(dir, `${id}.log`));
    if (result.status !== 0) throw new Error(`${id} failed; see ${id}.log`);
  };
  if (plan.requirements.build) {
    if (options['no-build']) {
      if (!existsSync(stamp) || readFileSync(stamp, 'utf8') !== fingerprint)
        throw new Error('Missing or stale isolated build');
    } else {
      run('build', ['exec', 'electron-vite', 'build', '--outDir', context.buildDir]);
      writeFileSync(stamp, fingerprint);
    }
  }
  if (plan.requirements.packaged) {
    const packageStamp = join(context.releaseDir, 'package-source.sha256');
    if (options['no-package']) {
      if (!existsSync(packageStamp) || readFileSync(packageStamp, 'utf8') !== fingerprint)
        throw new Error('Missing or stale isolated package');
      verifyRelease();
    } else {
      run('runtime', ['runtime:verify']);
      preparePackageDependencies(context, run);
      run('package', [
        'exec',
        'electron-builder',
        '--mac',
        'dir',
        '--arm64',
        `--config.directories.app=${context.appDir}`,
        `--config.directories.output=${context.releaseDir}`,
      ]);
      verifyRelease();
      writeFileSync(packageStamp, fingerprint);
    }
  }
  return { context, fingerprint };
}
const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export async function execute(plan, dir, onResult) {
  for (const level of ['unit', 'integration', 'tooling', 'e2e']) {
    const items = plan.tests.filter((item) => item.level === level);
    if (!items.length) continue;
    if (level === 'unit' || level === 'integration') {
      const json = join(dir, `${level}.vitest.json`),
        started = Date.now();
      const files = [...new Set(items.map((item) => item.file))];
      const args = ['run', ...files, '--reporter=json', `--outputFile=${json}`];
      if (level === 'integration')
        args.push('-t', items.map((item) => `(?:^| )${escaped(item.id)} `).join('|'));
      const env = { ...process.env };
      delete env.DEEPSEEK_API_KEY;
      delete env.OPENROUTER_API_KEY;
      env.DATA_AGENT_TEST_MODEL_MODE = 'none';
      const native = level === 'integration';
      if (native) env.ELECTRON_RUN_AS_NODE = '1';
      else delete env.ELECTRON_RUN_AS_NODE;
      const executable = native ? createRequire(import.meta.url)('electron') : process.execPath;
      const result = command(
        executable,
        [resolve('node_modules/vitest/vitest.mjs'), ...args],
        join(dir, `${level}.log`),
        env,
      );
      const report = existsSync(json) ? JSON.parse(readFileSync(json, 'utf8')) : null;
      for (const item of items) {
        const assertions =
          report?.testResults
            .filter((file) => resolve(file.name) === resolve(item.file))
            .flatMap((file) => file.assertionResults)
            .filter(
              (test) =>
                level === 'unit' || new RegExp(`(?:^| )${escaped(item.id)} `).test(test.fullName),
            ) ?? [];
        const passed =
          assertions.length > 0 &&
          assertions.every((test) => test.status === 'passed') &&
          !(report?.numRuntimeErrorTestSuites > 0) &&
          !result.error;
        onResult({
          id: item.id,
          status: passed ? 'passed' : 'failed',
          ms: Date.now() - started,
          assertions: assertions.length,
          ...(!passed ? { error: `Missing/failed/skipped assertions; see ${level}.log` } : {}),
        });
      }
      // A failing batch outside selected assertions must not disappear behind green per-case checks.
      if (result.status !== 0) throw new Error(`${level} process failed; see ${level}.log`);
    } else
      for (const item of items) {
        const started = Date.now();
        process.env.DATA_AGENT_TEST_MODEL_MODE = item.model;
        try {
          let detail;
          if (level === 'tooling') {
            const result = command(
              process.execPath,
              ['--test', item.file],
              join(dir, `${item.id}.log`),
            );
            if (result.status !== 0) throw new Error(`See ${item.id}.log`);
            detail = { runner: 'node:test' };
          } else {
            const module = await import(pathToFileURL(resolve(item.file)).href);
            const run = module.cases?.[item.id];
            if (typeof run !== 'function') throw new Error(`Missing implementation: ${item.id}`);
            detail = await run({ dir });
          }
          onResult({ id: item.id, status: 'passed', ms: Date.now() - started, detail });
        } catch (error) {
          onResult({
            id: item.id,
            status: 'failed',
            ms: Date.now() - started,
            error: String(error.stack ?? error),
          });
        }
      }
  }
}
