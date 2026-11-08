import { platform, release, arch, cpus, totalmem } from 'node:os';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs, selectTests } from './selection.mjs';
import { prepare, execute } from './execution.mjs';
import { auditRelease } from './release-audit.mjs';
import { saveReport } from './report.mjs';
import { withRunContext } from './run-context.mjs';

let dir, report;
try {
  const options = parseArgs(process.argv.slice(2));
  const plan = selectTests(options);
  if (options.list || options['dry-run']) console.log(JSON.stringify(plan, null, 2));
  else {
    if (plan.requirements.live && !options.live)
      throw new Error(
        'Live model calls require explicit --live. Use --dry-run to inspect costs first.',
      );
    dir = resolve(
      options['results-root'] ?? 'test-results',
      new Date().toISOString().replaceAll(':', '-'),
    );
    mkdirSync(dir, { recursive: true });
    report = {
      status: 'running',
      environment: {
        platform: platform(),
        release: release(),
        arch: arch(),
        node: process.version,
        cpu: cpus()[0]?.model,
        memoryBytes: totalmem(),
      },
      dependencies: JSON.parse(readFileSync('package.json', 'utf8')).dependencies,
      started: new Date().toISOString(),
      commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      plan,
      cases: [],
    };
    if (options.suite === 'release') {
      if (
        options.case ||
        options.feature ||
        options.level ||
        options.model ||
        options.affected ||
        options.packaged
      )
        throw new Error(
          'Release suite cannot be narrowed; use --feature or --case without --suite release',
        );
      execFileSync('pnpm', ['quality'], { stdio: 'inherit' });
    }
    // Do not start Electron, install dependencies or read credentials during selection/dry-run.
    if (plan.tests.length) {
      const { context, fingerprint } = prepare(plan, options, dir);
      report.context = context;
      report.sourceTreeHash = fingerprint;
      await withRunContext(context, () =>
        execute(plan, dir, (result) => {
          report.cases.push(result);
          saveReport(dir, report);
          console.log(`${result.id}: ${result.status}`);
        }),
      );
    }
    if (options.suite === 'release') report.releaseAudit = auditRelease(dir, report.context);
    report.status =
      report.cases.length === plan.tests.length &&
      report.cases.every((item) => item.status === 'passed')
        ? 'passed'
        : 'failed';
    if (!plan.tests.length)
      report.note = 'No runtime tests affected; run pnpm quality for static/documentation checks.';
    process.exitCode = report.status === 'passed' ? 0 : 1;
  }
} catch (error) {
  process.exitCode = 1;
  if (report) {
    report.status = 'failed';
    report.error = String(error.stack ?? error);
  } else console.error(String(error.message ?? error));
} finally {
  if (report) {
    saveReport(dir, report);
    console.log(
      JSON.stringify({ status: report.status, report: `${dir}/summary.json`, error: report.error }),
    );
  }
}
