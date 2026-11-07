import assert from 'node:assert/strict';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { createStoredSession, openWorkspaceFile, openPreview } from '../../support/desktop.mjs';
const require = createRequire(import.meta.url);

function memory(rootPid) {
  const processes = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number));
  const pids = new Set([rootPid]);
  for (let i = 0; i < 8; i++)
    for (const [pid, ppid] of processes) if (pids.has(ppid)) pids.add(pid);
  return {
    pids: [...pids],
    rssKiB: processes.filter(([pid]) => pids.has(pid)).reduce((sum, row) => sum + row[2], 0),
  };
}
function fixture(points, charts, padding = 0) {
  const lib = readFileSync(require.resolve('echarts/dist/echarts.min.js'), 'utf8');
  return `<!doctype html><meta charset="utf-8"><style>body{font:16px system-ui}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}.chart{height:250px}</style>
<h1>Performance fixture</h1><label>Range<select id="scope"><option value="all">All</option><option value="quarter">Quarter</option></select></label><output id="count"></output><main>${'<div class="chart"></div>'.repeat(charts)}</main>
<script>${lib}</script><script>
const points=Array.from({length:${points}},(_,i)=>[i,Math.sin(i/10)*10+i/100]);
const charts=[...document.querySelectorAll('.chart')].map(e=>echarts.init(e));
function render(){const data=document.querySelector('select').value==='all'?points:points.slice(0,points.length/4);for(const chart of charts){chart.setOption({animation:false,xAxis:{type:'value'},yAxis:{},series:[{type:'line',showSymbol:false,sampling:'lttb',data}]},{notMerge:true})}document.querySelector('output').textContent=data.length;document.body.dataset.ready='true'}
document.querySelector('select').onchange=render;render();
</script><!--${'x'.repeat(padding)}-->`;
}
export const cases = {
  async 'performance.interactive-reports'({ dir }) {
    const app = await startApp(join(dir, 'html-performance'));
    let peak = 0;
    const sample = () => {
      peak = Math.max(peak, memory(app.child.pid).rssKiB);
    };
    const timer = setInterval(sample, 150);
    try {
      const stored = await createStoredSession(app.page);
      await openPreview(app.page, '文件');
      const samples = [];
      for (const [name, points, charts, padding] of [
        ['single', 1000, 1, 0],
        ['multiple', 20000, 6, 0],
        ['near-limit', 1000, 1, 30 * 1024 * 1024],
      ]) {
        const html = fixture(points, charts, padding);
        const bytes = Buffer.byteLength(html);
        assert(bytes < 32 * 1024 * 1024);
        writeFileSync(join(stored.workspace, `${name}.html`), html);
        await app.page.getByRole('button', { name: '刷新工作区', exact: true }).click();
        const before = memory(app.child.pid);
        peak = before.rssKiB;
        const start = performance.now();
        await openWorkspaceFile(app.page, `${name}.html`);
        const report = await until(
          () =>
            app.browser
              .contexts()
              .flatMap((c) => c.pages())
              .find((p) => p.url().startsWith('data-report:')),
          'performance page',
        );
        await report.locator('body[data-ready=true]').waitFor();
        await until(
          () => report.evaluate(() => innerWidth > 100 && innerHeight > 100),
          'performance view layout',
        );
        const readyMs = performance.now() - start;
        assert.equal(Number(await report.locator('#count').textContent()), points);
        const filterStart = performance.now();
        await report.locator('#scope').selectOption('quarter');
        assert.equal(Number(await report.locator('#count').textContent()), points / 4);
        const filterMs = performance.now() - filterStart;
        sample();
        const active = memory(app.child.pid);
        assert(readyMs < 15000, 'fixture first interaction exceeds 15s');
        assert(filterMs < 5000, 'fixture filtering exceeds 5s');
        await report.screenshot({ path: join(dir, `performance-${name}.png`) });
        writeFileSync(join(stored.workspace, 'close.txt'), 'Close the active HTML.');
        // Explicit refresh and selecting a non-HTML file must release its view.
        await app.page.getByRole('button', { name: '刷新工作区', exact: true }).click();
        await openWorkspaceFile(app.page, 'close.txt');
        await until(() => report.isClosed(), 'performance report closed');
        await until(
          () =>
            !app.browser
              .contexts()
              .flatMap((c) => c.pages())
              .some((p) => p.url().startsWith('data-report:')),
          'all report pages released',
        );
        const after = memory(app.child.pid);
        samples.push({
          name,
          points,
          charts,
          bytes,
          readyMs,
          filterMs,
          peakTreeRssKiB: peak,
          beforeRssKiB: before.rssKiB,
          afterRssKiB: after.rssKiB,
          releasedProcessIds: active.pids.filter((pid) => !after.pids.includes(pid)),
        });
      }
      assert.deepEqual(app.errors, []);
      writeFileSync(join(dir, 'html-performance.json'), JSON.stringify(samples, null, 2));
      return {
        samples,
        memoryScope:
          'sampled RSS of the entire isolated application process tree; allocator caches may remain after report close',
      };
    } finally {
      clearInterval(timer);
      await app.stop();
    }
  },
};
