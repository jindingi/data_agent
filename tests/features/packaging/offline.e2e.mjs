import { openPreview } from '../../support/desktop.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { modelFixture } from '../../../scripts/test/model-fixture.mjs';
import { configure, rpc, settled } from '../../support/desktop.mjs';

const taskTool = (name, args) => ({ tool: { name, args } });

async function listing(page, sessionId) {
  return until(async () => {
    const v = await rpc(page, { type: 'artifacts.list', sessionId });
    return v.versions.length && v.versions.every((v) => v.state === 'published') ? v : null;
  }, 'all versions published');
}

async function deliver(page, sessionId, previousRunId) {
  const final = await until(
    async () => {
      const v = await rpc(page, { type: 'runtime.snapshot', sessionId });
      return v?.runId !== previousRunId && ['completed', 'failed', 'cancelled'].includes(v?.state)
        ? v
        : null;
    },
    'delivery terminal',
    60000,
  );
  assert.equal(final.state, 'completed', final.error ?? '');
  const files = (await listing(page, sessionId)).files.filter((f) => f.runId === final.runId);
  assert(files.some((f) => f.relativePath === 'report.md' && f.state === 'ready' && f.size > 0));
  assert(files.some((f) => f.kind === 'png' && f.state === 'ready' && f.size > 0));
  await openPreview(page, '预览');
  await until(
    () =>
      page
        .locator('.artifact-markdown img')
        .evaluateAll(
          (images) => images.length > 0 && images.every((i) => i.complete && i.naturalWidth > 0),
        ),
    'report PNG decoded',
  );
  return final;
}

function tree(root) {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((s) => s.trim().split(/\s+/).map(Number));
  const ids = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, parent] of rows)
      if (ids.has(parent) && !ids.has(id)) {
        ids.add(id);
        changed = true;
      }
  }
  return [...ids];
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function story(dir, offline) {
  const root = resolve(dir, offline ? 'p7-offline' : 'p7-cdp'),
    source = join(root, '输入 数据.csv');
  mkdirSync(root, { recursive: true });
  const original = 'region,sales\n北区,10\n南区,20\n';
  writeFileSync(source, original);
  const fixture = await modelFixture();
  let app;
  const options = {
    packaged: true,
    offline,
    minimalEnvironment: true,
    pickFiles: [source],
    testModelBaseUrl: fixture.baseUrl,
  };
  const allPids = new Set();
  const track = () => tree(app.child.pid).forEach((pid) => allPids.add(pid));
  try {
    app = await startApp(join(root, 'app'), options);
    let page = app.page;
    await configure(page);
    await page.getByRole('button', { name: '添加 CSV 文件', exact: true }).click();

    await page.getByRole('button', { name: '移除文件 输入 数据.csv', exact: true }).waitFor();
    const script = `from pathlib import Path\nimport sys,json,pandas as pd,matplotlib.pyplot as plt\nd=pd.read_csv(${JSON.stringify(source)})\nplt.bar(d.region,d.sales);plt.title('地区销售');plt.savefig('chart.png');plt.close()\nPath('report.md').write_text('# Packaged delivery\\n\\n![地区销售](chart.png)\\n',encoding='utf-8')\nprint(json.dumps({'python':sys.executable}))\n`;
    fixture.set(
      taskTool('write', { path: 'analysis.py', content: script }),
      taskTool('bash', { command: 'python3 analysis.py' }),
      { text: 'Packaged task delivered.' },
    );
    await page.getByRole('textbox', { name: '分析需求' }).fill('生成 report.md 与中文图表');
    await page.getByRole('button', { name: '发送分析需求', exact: true }).click();
    const id = await until(
      () => page.getByTestId('session-title').getAttribute('data-session-id'),
      'input session',
    );
    const first = await deliver(page, id);
    track();
    assert(
      first.tools.some((t) => t.output.includes('/Contents/Resources/runtime/python/bin/python3')),
    );
    assert(!JSON.stringify(fixture.requests).includes('剩余最多'));
    for (let i = 1; i < fixture.requests.length; i++) {
      assert.deepEqual(
        fixture.requests[i].messages.slice(0, fixture.requests[i - 1].messages.length),
        fixture.requests[i - 1].messages,
      );
    }
    fixture.set(
      taskTool('write', {
        path: 'analysis.py',
        content: script.replace('Packaged delivery', 'Packaged followup'),
      }),
      taskTool('bash', { command: 'python3 analysis.py' }),
      { text: 'New report delivered.' },
    );
    await page.getByRole('textbox', { name: '分析需求' }).fill('继续，生成新版报告和图表。');
    await page.getByRole('button', { name: '发送分析需求', exact: true }).click();
    const second = await deliver(page, id, first.runId);
    assert.equal(first.outputDirectory, second.outputDirectory);
    assert(
      readFileSync(join(first.outputDirectory, 'report.md'), 'utf8').includes('Packaged followup'),
    );
    track();
    assert.deepEqual(app.errors, []);
    await app.stop();
    app = await startApp(join(root, 'app'), options);
    page = app.page;
    const restored = await rpc(page, { type: 'runtime.snapshot', sessionId: id });
    assert.equal(restored.runId, second.runId);
    assert(
      restored.messages.some((m) =>
        m.blocks.some((b) => b.text?.includes('Packaged task delivered')),
      ),
    );
    const outside = join(root, 'must-not-write.txt');
    fixture.set(taskTool('write', { path: outside, content: 'must not execute' }), {
      text: 'Denied operation handled.',
    });
    await page.getByRole('textbox', { name: '分析需求' }).fill('Exercise explicit denial.');
    await page.getByRole('button', { name: '发送分析需求', exact: true }).click();
    await page.getByRole('region', { name: '安全审批', exact: true }).waitFor();
    assert(!existsSync(outside));
    await page.getByRole('button', { name: '拒绝', exact: true }).click();
    await settled(page, id);
    assert(!existsSync(outside));
    fixture.set(
      taskTool('bash', {
        command: 'while [ ! -f release ]; do printf tick >> heartbeat.txt; sleep 0.1; done',
      }),
      { text: 'Should be cancelled.' },
    );
    await page.getByRole('textbox', { name: '分析需求' }).fill('Exercise stop.');
    await page.getByRole('button', { name: '发送分析需求', exact: true }).click();
    const working = await until(async () => {
      const v = await rpc(page, { type: 'runtime.snapshot', sessionId: id });
      return v?.state === 'running' &&
        v.outputDirectory &&
        existsSync(join(v.outputDirectory, 'heartbeat.txt'))
        ? v
        : null;
    }, 'actual worker heartbeat');
    track();
    const hostPid = await rpc(page, {
      type: 'automation.control',
      action: 'host_pid',
      sessionId: id,
    });
    await page.getByRole('button', { name: '停止', exact: true }).click();
    assert.equal((await settled(page, id)).state, 'cancelled');
    await until(() => !alive(hostPid), 'cancelled Host exit');
    const bytes = statSync(join(working.outputDirectory, 'heartbeat.txt')).size;
    await delay(1000);
    assert.equal(statSync(join(working.outputDirectory, 'heartbeat.txt')).size, bytes);
    if (offline) {
      const probe = `import socket,sys,subprocess,json\ns=socket.socket();s.settimeout(1);parent=s.connect_ex(('192.0.2.1',443));s.close()\nchild=subprocess.check_output([sys.executable,'-I','-B','-c',"import socket; s=socket.socket();s.settimeout(1);print(s.connect_ex(('192.0.2.1',443)))"],text=True)\nprint(json.dumps({'parentErrno':parent,'childErrno':int(child)}))\n`;
      fixture.set(
        taskTool('write', { path: 'network_probe.py', content: probe }),
        taskTool('bash', { command: 'python3 network_probe.py' }),
        { text: 'Network denial observed.' },
      );
      await page
        .getByRole('textbox', { name: '分析需求' })
        .fill('Verify test-only OS network denial.');
      await page.getByRole('button', { name: '发送分析需求', exact: true }).click();
      await page.getByRole('region', { name: '安全审批', exact: true }).waitFor();
      const pending = await rpc(page, { type: 'runtime.snapshot', sessionId: id });
      assert(pending.interactions[0].description.includes('network_probe.py'));
      // Exactly this fixed, reviewed fixture probes a reserved documentation IP; never approve arbitrary model code.
      await page.getByRole('button', { name: '允许这一次', exact: true }).click();
      const final = await settled(page, id);
      const bash = final.tools.findLast(
        (t) => t.name === 'bash' && JSON.parse(t.arguments).command === 'python3 network_probe.py',
      );
      assert(bash, 'network probe tool result present');
      assert.equal(bash.status, 'completed', bash.output);
      const observed = JSON.parse(bash.output.split('\n').find((line) => line.startsWith('{')));
      assert.deepEqual(observed, { parentErrno: 1, childErrno: 1 });
    }
    assert.equal(readFileSync(source, 'utf8'), original);
    assert.deepEqual(app.errors, []);
    track();
    await page.screenshot({ path: join(root, 'final.png') });
    await app.stop();
    app = undefined;
    await until(
      () => [...allPids].every((pid) => !alive(pid)),
      'zero tracked app/Host/tool residuals',
      10000,
    );
    const result = {
      packaged: true,
      offline,
      minimalPath: '/usr/bin:/bin',
      reportAndPngDisplayed: true,
      nativeHistoryRestart: true,
      oldVersionPreserved: true,
      denialNoWrite: true,
      actualWorkerStopped: true,
      sourceUnchanged: true,
      networkBlockedInWorkerAndDescendant: offline,
      requests: fixture.requests.length,
      trackedPids: [...allPids],
      residuals: 0,
    };
    writeFileSync(join(root, 'evidence.json'), JSON.stringify(result, null, 2));
    return result;
  } finally {
    await app?.stop();
    await fixture.close();
  }
}
export const cases = {
  'packaging.offline': ({ dir }) => story(dir, true),
};
