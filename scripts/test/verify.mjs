import { cases as turnUsage } from '../../tests/e2e/turn-usage.mjs';
import { cases as ux } from '../../tests/e2e/ux.mjs';
import { cases as filePreview } from '../../tests/e2e/file-preview.mjs';
import { cases as executionProcess } from '../../tests/e2e/execution-process.mjs';
import { nativeIds, mergeCases, requirementsFor } from './case-registry.mjs';
import { createRunContext, setRunContext, preparePackageDependencies } from './run-context.mjs';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { platform, arch, release } from 'node:os';
import { cases as p0 } from '../../tests/e2e/p0.mjs';
import { cases as p1 } from '../../tests/e2e/p1.mjs';
import { cases as p2 } from '../../tests/e2e/p2.mjs';
import { cases as p3 } from '../../tests/e2e/p3.mjs';
import { cases as p4 } from '../../tests/e2e/p4.mjs';
import { cases as p5 } from '../../tests/e2e/p5.mjs';
import { cases as p6 } from '../../tests/e2e/p6.mjs';
import { cases as p7 } from '../../tests/e2e/p7.mjs';
import { verifyRelease } from '../build/verify-release.mjs';

const args = process.argv.slice(2).filter((x) => x !== '--');
const phase = args.find((a) => /^P\d+$/.test(a));
const caseIndex = args.indexOf('--case');
const selected = caseIndex >= 0 ? args[caseIndex + 1] : undefined;
const stamp = new Date().toISOString().replaceAll(':', '-');
const dir = resolve('test-results', stamp);
mkdirSync(dir, { recursive: true });
const contextIndex = args.indexOf('--run-root');
if (contextIndex >= 0 && !args[contextIndex + 1]) throw new Error('--run-root requires a path');
const context = createRunContext(contextIndex >= 0 ? args[contextIndex + 1] : dir);
setRunContext(context);
const summary = {
  phase: phase ?? 'targeted',
  started: new Date().toISOString(),
  platform: platform(),
  arch: arch(),
  os: release(),
  cases: [],
  status: 'running',
};
const manifest =
  phase && existsSync(`tests/phases/${phase}.json`)
    ? JSON.parse(readFileSync(`tests/phases/${phase}.json`, 'utf8'))
    : null;
const command = (id, cmd) => {
  const result = spawnSync('pnpm', cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  writeFileSync(join(dir, `${id}.log`), (result.stdout ?? '') + (result.stderr ?? ''));
  if (result.status !== 0) throw new Error(`${id} failed (${result.status}): see ${id}.log`);
};
function nativeCase(id) {
  const jsonFile = join(dir, `${id}.vitest.json`);
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
  delete env.DEEPSEEK_API_KEY;
  const result = spawnSync(
    createRequire(import.meta.url)('electron'),
    [
      resolve('node_modules/vitest/vitest.mjs'),
      'run',
      'tests/integration',
      '-t',
      id,
      '--reporter=json',
      `--outputFile=${jsonFile}`,
    ],
    { env, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  );
  writeFileSync(join(dir, `${id}.log`), (result.stdout ?? '') + (result.stderr ?? ''));
  if (result.status !== 0 || !existsSync(jsonFile))
    throw new Error(`Native integration failed: ${id}.log`);
  const report = JSON.parse(readFileSync(jsonFile, 'utf8'));
  const matches = report.testResults
    .flatMap((r) => r.assertionResults)
    .filter((r) => r.fullName.includes(id));
  if (matches.length !== 1 || matches[0].status !== 'passed')
    throw new Error('Native case missing, skipped or failed');
  return { assertion: matches[0].fullName, electronNodeABI: true };
}
const cases = mergeCases(
  executionProcess,
  turnUsage,
  filePreview,
  ux,
  p0,
  p1,
  p2,
  p3,
  p4,
  p5,
  p6,
  p7,
  Object.fromEntries(nativeIds.map((id) => [id, async () => nativeCase(id)])),
  {
    'P0-CHECK': async () => {
      command('typecheck', ['check']);
      command('unit', ['test:unit']);
      return { commands: ['pnpm check', 'pnpm test:unit'] };
    },
  },
);
cases['P7-ALL'] = async () => {
  if (phase !== 'P7' || !manifest) throw new Error('P7-ALL requires the complete P7 gate');
  const expected = manifest.required.filter((id) => id !== 'P7-ALL');
  if (
    summary.cases.length !== expected.length ||
    expected.some((id) => !summary.cases.some((c) => c.id === id && c.status === 'passed'))
  )
    throw new Error('Not all required cases passed');
  const probe = execFileSync(
    resolve('runtime/darwin-arm64/python/bin/python3'),
    [
      '-I',
      '-B',
      '-c',
      `import psutil,sys,os,json
root=sys.argv[1];found=[]
for p in psutil.process_iter(['pid','cmdline','cwd']):
 if p.pid in (os.getpid(),os.getppid()):continue
 try:
  args=p.info['cmdline'] or [];cwd=p.info['cwd'] or '';home=p.environ().get('DATA_AGENT_HOME','')
  if cwd.startswith(root+'/') or home.startswith(root+'/') or any(root+'/' in arg for arg in args):found.append({'pid':p.pid,'name':p.name()})
 except (psutil.NoSuchProcess,psutil.AccessDenied):pass
print(json.dumps(found))`,
      dir,
    ],
    { encoding: 'utf8' },
  );
  const residuals = JSON.parse(probe);
  if (residuals.length) throw new Error(`Test process residuals: ${JSON.stringify(residuals)}`);
  return { requiredCasesPassed: expected.length, residuals, release: verifyRelease() };
};
function save() {
  summary.finished = new Date().toISOString();
  summary.total = summary.cases.length;
  summary.passed = summary.cases.filter((c) => c.status === 'passed').length;
  summary.failed = summary.cases.filter((c) => c.status === 'failed').length;
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  const escape = (s) =>
    String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  writeFileSync(
    join(dir, 'junit.xml'),
    `<testsuite name="${escape(summary.phase)}" tests="${summary.total}" failures="${summary.failed}">${summary.cases.map((c) => `<testcase name="${escape(c.id)}" time="${c.ms / 1000}">${c.status === 'failed' ? `<failure message="${escape(c.error)}"/>` : ''}</testcase>`).join('')}</testsuite>`,
  );
  writeFileSync(
    join(dir, 'report.md'),
    `# ${summary.phase}: ${summary.status}\n\n${summary.cases.map((c) => `- ${c.id}: ${c.status}${c.error ? ` — ${c.error}` : ''}`).join('\n')}\n`,
  );
}
try {
  summary.commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const sourceHash = createHash('sha256');
  const sources = [
    ...new Set(
      execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
        encoding: 'utf8',
      })
        .split('\0')
        .filter(Boolean),
    ),
  ].sort();
  for (const file of sources)
    if (existsSync(file))
      sourceHash.update(file).update('\0').update(readFileSync(file)).update('\0');
  summary.sourceTreeHash = sourceHash.digest('hex');
  summary.context = context;
  summary.sourceFiles = sources.length;
  summary.macOS = execFileSync('/usr/bin/sw_vers', ['-productVersion'], {
    encoding: 'utf8',
  }).trim();
  summary.cpu = execFileSync('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string'], {
    encoding: 'utf8',
  }).trim();
  summary.memoryBytes = Number(
    execFileSync('/usr/sbin/sysctl', ['-n', 'hw.memsize'], { encoding: 'utf8' }).trim(),
  );
  summary.dependencies = JSON.parse(readFileSync('package.json', 'utf8')).dependencies;
  if (phase && !manifest)
    throw new Error(`Phase ${phase} is not implemented; cannot pass or skip.`);
  if (caseIndex >= 0 && !selected) throw new Error('--case requires a case ID');
  if (phase && selected)
    throw new Error(
      'A phase gate must run all required cases; use test:e2e -- --case for targeted testing',
    );

  let ids =
    manifest?.required ??
    (selected
      ? [selected]
      : args.includes('--packaged')
        ? args.includes('--live')
          ? ['P7-LIVE']
          : ['P7-PACKAGE', 'P7-OFFLINE', 'P7-CDP', 'P7-DEFAULTS']
        : args.includes('--live')
          ? Object.keys(p2)
          : args.includes('--integration')
            ? nativeIds
            : [...Object.keys(p0).filter((id) => id !== 'P0-PACKAGE'), ...Object.keys(p1)]);
  if (!ids.length || ids.some((id) => !cases[id]))
    throw new Error('Missing or unknown required test');
  const requirements = requirementsFor(ids);
  const buildStamp = join(context.appDir, 'build-source.sha256');
  if (
    requirements.build &&
    args.includes('--no-build') &&
    (!existsSync(buildStamp) || readFileSync(buildStamp, 'utf8') !== summary.sourceTreeHash)
  )
    throw new Error('Missing or stale isolated build; rebuild without --no-build');
  if (requirements.build && !args.includes('--no-build')) {
    command('build', ['exec', 'electron-vite', 'build', '--outDir', context.buildDir]);
    writeFileSync(buildStamp, summary.sourceTreeHash);
  }
  if (args.includes('--no-package')) {
    if (!selected) throw new Error('--no-package is only for targeted checks');
    if (requirements.packaged) verifyRelease();
  }
  if (!args.includes('--no-package') && requirements.packaged) {
    command('runtime', ['runtime:verify']);
    preparePackageDependencies(context, command);
    command('package', [
      'exec',
      'electron-builder',
      '--mac',
      'dir',
      '--arm64',
      `--config.directories.app=${context.appDir}`,
      `--config.directories.output=${context.releaseDir}`,
    ]);
  }
  for (const id of ids) {
    const started = Date.now();
    try {
      const detail = await cases[id]({ dir });
      summary.cases.push({ id, status: 'passed', ms: Date.now() - started, detail });
    } catch (error) {
      summary.cases.push({
        id,
        status: 'failed',
        ms: Date.now() - started,
        error: String(error.stack ?? error),
      });
    }
    save();
    console.log(`${id}: ${summary.cases.at(-1).status}`);
  }
  summary.status =
    summary.cases.length === ids.length && summary.cases.every((c) => c.status === 'passed')
      ? 'passed'
      : 'failed';
  process.exitCode = summary.status === 'passed' ? 0 : 1;
} catch (error) {
  summary.status = 'failed';
  summary.error = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  save();
  console.log(
    JSON.stringify({
      status: summary.status,
      report: join(dir, 'summary.json'),
      error: summary.error,
    }),
  );
}
