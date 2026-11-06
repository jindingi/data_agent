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

const args = process.argv.slice(2).filter(x => x !== '--');
const phase = args.find(a => /^P\d+$/.test(a));
const caseIndex = args.indexOf('--case'); const selected = caseIndex >= 0 ? args[caseIndex + 1] : undefined;
const stamp = new Date().toISOString().replaceAll(':', '-');
const dir = resolve('test-results', stamp); mkdirSync(dir, { recursive: true });
const summary = { phase: phase ?? 'targeted', started: new Date().toISOString(), platform: platform(), arch: arch(), os: release(), cases: [], status: 'running' };
const manifest = phase && existsSync(`tests/phases/${phase}.json`) ? JSON.parse(readFileSync(`tests/phases/${phase}.json`, 'utf8')) : null;
const command = (id, cmd) => {
  const result = spawnSync('pnpm', cmd, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  writeFileSync(join(dir, `${id}.log`), (result.stdout ?? '') + (result.stderr ?? ''));
  if (result.status !== 0) throw new Error(`${id} failed (${result.status}): see ${id}.log`);
};
const nativeIds = ['P6-OUTPUT-LIMIT', 'P6-LOG-LIMIT', 'P6-DELETE-STORAGE', 'P6-LOG-STORAGE', 'P6-READ-ENCODING', 'P4-ARTIFACT', 'P4-VERSIONS', 'P3-TOOLS', 'P3-POLICY', 'P3-READ-POLICY', 'P3-NETWORK', 'P3-CANCEL', 'P1-SCHEMA', 'P1-TREE', 'P1-RECOVERY', 'P1-COORDINATION', 'P2-STREAM', 'P2-SNAPSHOT', 'P2-IDENTITY', 'P2-CREDENTIAL', 'P2-READ-BOUNDS', 'P2-PREFLIGHT', 'P2-REQUEST-LIMIT'];
function nativeCase(id) {
  const jsonFile = join(dir, `${id}.vitest.json`);
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }; delete env.DEEPSEEK_API_KEY;
  const result = spawnSync(createRequire(import.meta.url)('electron'), [resolve('node_modules/vitest/vitest.mjs'), 'run', 'tests/integration', '-t', id, '--reporter=json', `--outputFile=${jsonFile}`], { env, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  writeFileSync(join(dir, `${id}.log`), (result.stdout ?? '') + (result.stderr ?? ''));
  if (result.status !== 0 || !existsSync(jsonFile)) throw new Error(`Native integration failed: ${id}.log`);
  const report = JSON.parse(readFileSync(jsonFile, 'utf8'));
  const matches = report.testResults.flatMap(r => r.assertionResults).filter(r => r.fullName.includes(id));
  if (matches.length !== 1 || matches[0].status !== 'passed') throw new Error('Native case missing, skipped or failed');
  return { assertion: matches[0].fullName, electronNodeABI: true };
}
const cases = { ...p0, ...p1, ...p2, ...p3, ...p4, ...p5, ...p6, ...Object.fromEntries(nativeIds.map(id => [id, async () => nativeCase(id)])), 'P0-CHECK': async () => { command('typecheck', ['check']); command('unit', ['test:unit']); return { commands: ['pnpm check', 'pnpm test:unit'] }; } };
function save() {
  summary.finished = new Date().toISOString(); summary.total = summary.cases.length;
  summary.passed = summary.cases.filter(c => c.status === 'passed').length;
  summary.failed = summary.cases.filter(c => c.status === 'failed').length;
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
  const escape = s => String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  writeFileSync(join(dir, 'junit.xml'), `<testsuite name="${escape(summary.phase)}" tests="${summary.total}" failures="${summary.failed}">${summary.cases.map(c => `<testcase name="${escape(c.id)}" time="${c.ms / 1000}">${c.status === 'failed' ? `<failure message="${escape(c.error)}"/>` : ''}</testcase>`).join('')}</testsuite>`);
  writeFileSync(join(dir, 'report.md'), `# ${summary.phase}: ${summary.status}\n\n${summary.cases.map(c => `- ${c.id}: ${c.status}${c.error ? ` — ${c.error}` : ''}`).join('\n')}\n`);
}
try {
  summary.commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const sourceHash = createHash('sha256');
  const sources = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean))].sort();
  for (const file of sources) if (existsSync(file)) sourceHash.update(file).update('\0').update(readFileSync(file)).update('\0');
  summary.sourceTreeHash = sourceHash.digest('hex');
  summary.sourceFiles = sources.length;
  summary.macOS = execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim();
  summary.cpu = execFileSync('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string'], { encoding: 'utf8' }).trim();
  summary.memoryBytes = Number(execFileSync('/usr/sbin/sysctl', ['-n', 'hw.memsize'], { encoding: 'utf8' }).trim());
  summary.dependencies = JSON.parse(readFileSync('package.json', 'utf8')).dependencies;
  if (phase && !manifest) throw new Error(`Phase ${phase} is not implemented; cannot pass or skip.`);
  if (caseIndex >= 0 && !selected) throw new Error('--case requires a case ID');
  if (phase && selected) throw new Error('A phase gate must run all required cases; use test:e2e -- --case for targeted testing');

  let ids = manifest?.required ?? (selected ? [selected] : args.includes('--live') ? Object.keys(p2) : args.includes('--integration') ? nativeIds : args.includes('--packaged') ? ['P0-PACKAGE'] : [...Object.keys(p0).filter(id => id !== 'P0-PACKAGE'), ...Object.keys(p1)]);
  if (!ids.length || ids.some(id => !cases[id])) throw new Error('Missing or unknown required test');
  if (!args.includes('--no-build')) command('build', ['build']);
  if (ids.some(id => ['P0-PACKAGE', 'P3-RUNTIME'].includes(id))) { command('runtime', ['runtime:verify']); command('package', ['exec', 'electron-builder', '--mac', 'dir', '--arm64']); }
  for (const id of ids) {
    const started = Date.now();
    try { const detail = await cases[id]({ dir }); summary.cases.push({ id, status: 'passed', ms: Date.now() - started, detail }); }
    catch (error) { summary.cases.push({ id, status: 'failed', ms: Date.now() - started, error: String(error.stack ?? error) }); }
    save(); console.log(`${id}: ${summary.cases.at(-1).status}`);
  }
  summary.status = summary.cases.length === ids.length && summary.cases.every(c => c.status === 'passed') ? 'passed' : 'failed';
  process.exitCode = summary.status === 'passed' ? 0 : 1;
} catch (error) {
  summary.status = 'failed'; summary.error = String(error.stack ?? error); process.exitCode = 1;
} finally { save(); console.log(JSON.stringify({ status: summary.status, report: join(dir, 'summary.json'), error: summary.error })); }
