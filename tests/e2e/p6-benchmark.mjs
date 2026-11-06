import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, openSync, writeSync, closeSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { startApp, until } from '../../scripts/test/harness.mjs';
import { modelFixture } from '../../scripts/test/model-fixture.mjs';
import { rpc, configure } from './p3.mjs';

function generate(path, size, shift) {
  const header = 'date,region,amount,order_id,padding\n', headerBytes = Buffer.byteLength(header), rowBytes = 128;
  const rows = Math.floor((size - headerBytes) / rowBytes), extra = size - headerBytes - rows * rowBytes;
  const fd = openSync(path, 'w'); const hash = createHash('sha256');
  const write = value => { const bytes = Buffer.from(value); let offset = 0; while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset); hash.update(bytes); };
  try {
    write(header); let batch = '';
    for (let i = 0; i < rows; i++) {
      const start = `2026-0${7 + (i + shift) % 3}-01,R${(i + shift) % 4},${100 + i % 100}.00,${String(i).padStart(8, '0')},`;
      batch += start + 'x'.repeat(rowBytes - start.length - 1 + (i === rows - 1 ? extra : 0)) + '\n';
      if (i % 10000 === 9999) { write(batch); batch = ''; }
    }
    if (batch) write(batch);
  } finally { closeSync(fd); }
  assert.equal(statSync(path).size, size); return { path, size, rows, sha256: hash.digest('hex'), rowBytes, lastRowExtraBytes: extra };
}
export async function benchmark({ dir }) {
  const root = resolve(dir, 'p6-100mb'); mkdirSync(root, { recursive: true });
  const inputs = [generate(join(root, 'table-a.csv'), 50_000_000, 0), generate(join(root, 'table-b.csv'), 50_000_000, 1)];
  assert.equal(inputs.reduce((sum, file) => sum + file.size, 0), 100_000_000);
  const script = `from pathlib import Path
import pandas as pd
import matplotlib.pyplot as plt
frames = [pd.read_csv(${JSON.stringify(inputs[0].path)}, usecols=['date','region','amount'], dtype={'region':'category','amount':'float64'}), pd.read_csv(${JSON.stringify(inputs[1].path)}, usecols=['date','region','amount'], dtype={'region':'category','amount':'float64'})]
data = pd.concat(frames, ignore_index=True)
data['month'] = pd.to_datetime(data['date']).dt.strftime('%Y-%m')
summary = data.groupby(['month','region'], observed=True)['amount'].sum().unstack(fill_value=0)
regional = data.groupby('region', observed=True)['amount'].agg(['count','sum','mean'])
summary.plot(figsize=(8,4)); plt.title('100 MB 工作台流程基准'); plt.tight_layout(); plt.savefig('chart.png'); plt.close()
Path('report.md').write_text('# 100 MB pipeline fixture\\n\\nThis report exercises delivery, not a business correctness oracle.\\n\\n' + summary.to_string() + '\\n\\n' + regional.to_string() + '\\n\\n![chart](chart.png)\\n', encoding='utf-8')
print('BENCHMARK_DELIVERED')
`;
  const reply = payload => {
    const tool = payload.messages.filter(message => message.role === 'assistant' && message.tool_calls?.length).at(-1)?.tool_calls.at(-1)?.function.name;
    if (!tool) return { tool: { name: 'write', args: { path: 'analysis.py', content: script } } };
    if (tool === 'write') return { tool: { name: 'bash', args: { command: 'python3 analysis.py' } } };
    return { text: 'Benchmark report and PNG delivered.' };
  };
  const fixture = await modelFixture(); let app, sampler; const samples = []; let fragment = '', samplerError = '';
  try {
    app = await startApp(join(root, 'app'), { testModelBaseUrl: fixture.baseUrl, pickFiles: inputs.map(input => input.path) }); const page = app.page; await configure(page);
    sampler = spawn(resolve('runtime/darwin-arm64/python/bin/python3.12'), ['-I', '-B', resolve('scripts/test/sample-rss.py'), String(app.child.pid)], { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
    sampler.stdout.on('data', bytes => { fragment += bytes.toString(); let end; while ((end = fragment.indexOf('\n')) >= 0) { samples.push(JSON.parse(fragment.slice(0, end))); fragment = fragment.slice(end + 1); } });
    sampler.stderr.on('data', bytes => { samplerError += bytes.toString(); });
    async function start(label) {
      const known = new Set((await rpc(page, { type: 'sessions.list' })).map(s => s.id));
      await page.getByRole('button', { name: '新会话', exact: true }).click();
      const id = await until(async () => { const id = await page.getByTestId('session-title').getAttribute('data-session-id'); return id && !known.has(id) ? id : null; }, 'benchmark session selected');
      await page.getByRole('button', { name: '添加 CSV 文件', exact: true }).click();
      await until(async () => (await rpc(page, { type: 'sessions.open', sessionId: id })).files.length === 2, '100 MB references attached');
      await page.getByRole('textbox', { name: '分析需求' }).fill(label); const started = performance.now(), epoch = Date.now() / 1000;
      await page.getByRole('button', { name: '发送分析需求', exact: true }).click(); return { id, started, epoch };
    }
    async function finish(run) {
      const snapshot = await until(async () => { const s = await rpc(page, { type: 'runtime.snapshot', sessionId: run.id }); return s && ['completed','failed','cancelled','interrupted'].includes(s.state) ? s : null; }, '100 MB run terminal', 180_000);
      const ms = performance.now() - run.started; assert.equal(snapshot.state, 'completed', snapshot.error ?? ''); assert(ms <= 180_000, `100 MB run took ${ms} ms`);
      const outputs = await until(async () => { const listing = await rpc(page, { type: 'artifacts.list', sessionId: run.id }); return listing.versions.length && listing.versions.every(v => v.state === 'published') ? listing : null; }, 'benchmark outputs published');
      for (const name of ['report.md','chart.png']) assert(outputs.files.some(file => file.relativePath === name && file.state === 'ready' && file.size > 0));
      const tool = snapshot.tools.find(t => t.name === 'bash'); assert.equal(tool.status, 'completed', tool.output);
      const [log] = await rpc(page, { type: 'logs.list', sessionId: run.id, toolCallId: tool.id }); assert(log.peakRss > 0 && log.peakRss <= 2 * 1024 ** 3, `Peak RSS ${log.peakRss}`);
      return { sessionId: run.id, ms, processTreePeakRss: log.peakRss, runId: snapshot.runId, startEpoch: run.epoch, endEpoch: Date.now() / 1000 };
    }
    fixture.set(reply, reply, reply); const single = await finish(await start('100 MB single session benchmark.'));
    fixture.set(...Array.from({ length: 6 }, () => reply)); const a = await start('100 MB concurrent A.'), b = await start('100 MB concurrent B.');
    await until(async () => { const values = await Promise.all([a,b].map(run => rpc(page, { type: 'runtime.snapshot', sessionId: run.id }))); return values.every(s => s?.tools.some(t => t.name === 'bash' && t.status === 'running')); }, 'two Python analyses overlap');
    const responses = [], duringActive = []; const results = Promise.all([finish(a), finish(b)]); let finishedRuns = false; void results.then(() => { finishedRuns = true; }, () => { finishedRuns = true; });
    for (let i = 0; i < 30; i++) {
      const button = page.getByRole('button', { name: '切换结果面板', exact: true }), pressed = await button.getAttribute('aria-pressed'); const started = performance.now();
      duringActive.push(!finishedRuns); await button.click(); await until(() => button.getAttribute('aria-pressed').then(value => value !== pressed), 'panel action committed', 2000); responses.push(performance.now() - started);
    }
    const concurrent = await results; const p95 = [...responses].sort((a,b) => a-b)[Math.ceil(responses.length * .95) - 1]; assert(p95 <= 500, `CDP p95 ${p95} ms`);
    assert(samples.length > 5, samplerError); const overlapSamples = samples.filter(s => s.time >= b.epoch && s.time <= Math.max(...concurrent.map(r => r.endEpoch)));
    assert(overlapSamples.length); const totalPythonPeakRss = Math.max(...overlapSamples.map(s => s.pythonRss)), appTreePeakRss = Math.max(...overlapSamples.map(s => s.appRss));
    assert(totalPythonPeakRss > 0); assert.deepEqual(app.errors, []);
    for (const input of inputs) assert.equal(createHash('sha256').update(readFileSync(input.path)).digest('hex'), input.sha256);
    const evidence = { inputs, generator: 'fixed 128-byte rows, three months, four regions, amounts and padded order IDs', task: 'read two tables with pandas, concatenate, aggregate by month/region and region, write PNG and Markdown', timing: 'UI send through terminal runtime snapshot; excludes fixture generation and file picker', sampler: '100 ms psutil app-descendant RSS; Python aggregate includes supervisors, per-tool peak comes from production supervisor', single, concurrent, totalPythonPeakRss, appTreePeakRss, cdpResponsesMs: responses, cdpP95Ms: p95, interactionsWhileRunsPending: duringActive.filter(Boolean).length, sourceFilesUnchanged: true };
    writeFileSync(join(root, 'benchmark.json'), JSON.stringify(evidence, null, 2)); writeFileSync(join(root, 'rss-samples.json'), JSON.stringify(samples)); return evidence;
  } finally {
    if (sampler && sampler.exitCode === null) { const exited = new Promise(resolve => sampler.once('exit', resolve)); sampler.kill('SIGTERM'); await exited; }
    await app?.stop(); await fixture.close();
  }
}
