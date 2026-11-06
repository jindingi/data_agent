import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { mkdirSync, openSync, closeSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
const require = createRequire(import.meta.url);
export async function until(fn, label, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await delay(75); }
  throw new Error(`Timed out: ${label}`);
}
export async function freePort() {
  const server = createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port; await new Promise(r => server.close(r)); return port;
}
export async function startApp(root, { packaged = false, packagedPath, offline = false, minimalEnvironment = false, automation = true, port: selectedPort, pickFiles, pickDirectory, exportDirectory, testModelBaseUrl } = {}) {
  root = resolve(root); mkdirSync(root, { recursive: true });
  const port = selectedPort ?? await freePort();
  const executable = packaged ? join(resolve(packagedPath ?? 'release/mac-arm64/Data Agent.app'), 'Contents/MacOS/Data Agent') : require('electron');
  if (!existsSync(executable)) throw new Error(`Missing executable: ${executable}`);
  const args = [...(packaged ? [] : [resolve('.')]), ...(automation ? ['--data-agent-automation'] : []), ...(offline ? ['--no-sandbox'] : []), `--remote-debugging-port=${port}`];
  const env = { ...(minimalEnvironment ? { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LANG: 'en_US.UTF-8', PATH: '/usr/bin:/bin' } : process.env), DATA_AGENT_HOME: join(root, 'data'), DATA_AGENT_USER_DATA: join(root, 'userData') };
  delete env.DATA_AGENT_TEST_EXPORT_DIRECTORY;
  if (automation && exportDirectory) env.DATA_AGENT_TEST_EXPORT_DIRECTORY = exportDirectory;
  delete env.DATA_AGENT_TEST_MODEL_BASE_URL;
  // Deliberately pass this even in the normal-startup test: Main must ignore it
  // without the explicit automation flag, rather than the harness hiding it.
  if (testModelBaseUrl) env.DATA_AGENT_TEST_MODEL_BASE_URL = testModelBaseUrl;
  delete env.DATA_AGENT_TEST_PICK_FILES; delete env.DATA_AGENT_TEST_PICK_DIRECTORY;
  if (automation && pickFiles) env.DATA_AGENT_TEST_PICK_FILES = JSON.stringify(pickFiles);
  if (automation && pickDirectory) env.DATA_AGENT_TEST_PICK_DIRECTORY = pickDirectory;
  delete env.ELECTRON_RUN_AS_NODE; delete env.DEEPSEEK_API_KEY;
  const logFile = join(root, 'electron.log'); const fd = openSync(logFile, 'a');
  // Test-only OS network denial; the product itself never uses sandbox-exec.
  // macOS cannot nest Chromium Seatbelt under this profile, so only this offline
  // test uses --no-sandbox. Normal packaged CDP/defaults cases retain Chromium sandbox.
  const profile = '(version 1)(allow default)(deny network-outbound)(allow network-outbound (remote ip "localhost:*") (remote unix-socket))';
  if (offline) writeFileSync(join(root, 'offline.sb'), profile);
  const child = spawn(offline ? '/usr/bin/sandbox-exec' : executable, offline ? ['-p', profile, executable, ...args] : args, { env, stdio: ['ignore', fd, fd] }); closeSync(fd);
  // Scope the idle/display sleep assertion to this real test instance, including failures.
  const awake = spawn('/usr/bin/caffeinate', ['-di', '-w', String(child.pid)], { env: { PATH: '/usr/bin:/bin' }, stdio: 'ignore' });
  const awakeExit = new Promise(resolve => { awake.once('exit', resolve); awake.once('error', resolve); });
  let exited = false; child.once('exit', () => { exited = true; });
  const exit = new Promise(r => child.once('exit', r));
  const errors = []; let browser; let page;
  async function stop() {
    if (page && !page.isClosed()) {
      try {
        await page.screenshot({ path: join(root, 'final-screen.png') });
        const { writeFileSync } = await import('node:fs');
        writeFileSync(join(root, 'final-dom.html'), await page.content());
      } catch { /* Crashed Renderer may no longer be accessible. */ }
    }
    if (!exited) {
      child.kill('SIGTERM');
      await Promise.race([exit, delay(8000)]);
      if (!exited) { child.kill('SIGKILL'); await exit; }
    }
    if (awake.exitCode === null) awake.kill('SIGTERM');
    await awakeExit;
    try { await browser?.close(); } catch { /* App already exited. */ }
  }
  try {
    if (automation) {
      const endpoint = await until(async () => {
        if (exited) throw new Error(`Electron exited before ready: ${readFileSync(logFile, 'utf8')}`);
        try { return await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { return null; }
      }, 'CDP ready', 30_000);
      browser = await chromium.connectOverCDP(endpoint.webSocketDebuggerUrl);
      page = await until(() => browser.contexts()[0]?.pages()[0], 'window created');
      page.on('pageerror', error => errors.push(error.message));
      await page.getByRole('textbox', { name: '分析需求' }).waitFor();
    } else {
      await until(() => {
        if (exited) throw new Error(`Normal startup exited: ${readFileSync(logFile, 'utf8')}`);
        return readFileSync(logFile, 'utf8').includes('Data Agent ready');
      }, 'normal startup', 30_000);
    }
    return { root, child, exit, page, browser, errors, port, logFile, stop };
  } catch (error) { await stop(); throw error; }
}
