import { expect, it } from 'vitest';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ProcessRunner } from '../../../src/node/process-runner';
import { getRuntimePaths } from '../../../src/node/runtime-paths';
import { readExampleBundle, exampleHash } from '../../../src/node/example-bundle';

it('examples.reproduction reruns shipped scripts after relocation using only bundled Python and local dependencies', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'example-reproduce-')));
  const resources = getRuntimePaths(resolve('.'), '', false);
  const runner = new ProcessRunner(resources, join(root, 'logs'));
  try {
    const { files, examples } = readExampleBundle(resolve('resources/examples'));
    for (const example of examples) {
      const cwd = join(root, example.id);
      mkdirSync(cwd);
      const prefix = `${example.directory}/workspace/`;
      for (const [path, bytes] of files) {
        if (!path.startsWith(prefix)) continue;
        const target = join(cwd, path.slice(prefix.length));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes);
      }
      mkdirSync(join(cwd, 'data'));
      const csv = files.get('datasets/netflix/netflix_titles.csv')!;
      writeFileSync(join(cwd, 'data/netflix_titles.csv'), csv);
      const scripts = example.report.endsWith('.md')
        ? ['analysis.py']
        : ['scripts/prepare_data.py', 'scripts/build_report.py'];
      for (const script of scripts) {
        const runId = randomUUID();
        const result = await runner.run({
          sessionId: example.id,
          runId,
          toolCallId: randomUUID(),
          hostPid: process.pid,
          argv: [resources.python, script],
          cwd,
          timeoutSeconds: 180,
        });
        expect(result.exitCode, JSON.stringify(result)).toBe(0);
        runner.releaseRun(runId);
      }
      expect(exampleHash(readFileSync(join(cwd, 'data/netflix_titles.csv')))).toBe(
        exampleHash(csv),
      );
      if (example.report.endsWith('.html'))
        expect(readFileSync(join(cwd, example.report))).toEqual(
          files.get(`${prefix}${example.report}`),
        );
      else {
        const metrics = JSON.parse(readFileSync(join(cwd, 'metrics.json'), 'utf8'));
        expect(metrics.unique_id).toBe(8807);
        expect(metrics.movie_min_median).toBe(98);
      }
    }
  } finally {
    runner.stop();
    rmSync(root, { recursive: true, force: true });
  }
}, 60000);
