import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareArtifacts } from '../build/artifacts.mjs';

function command(file, args, output, env = process.env) {
  const result = spawnSync(file, args, { encoding: 'utf8', env, maxBuffer: 20 * 1024 * 1024 });
  writeFileSync(output, (result.stdout ?? '') + (result.stderr ?? ''));
  return result;
}
export function prepare(plan, options, dir) {
  const context = prepareArtifacts({
    root: options['run-root'] ?? dir,
    build: plan.requirements.build,
    packaged: plan.requirements.packaged,
    reuseBuild: options['no-build'],
    reusePackage: options['no-package'],
  });
  return { context, fingerprint: context.fingerprint };
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
