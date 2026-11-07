import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { freePort, until } from './harness.mjs';

/** Exercise the real pnpm dev command without replacing out/ or any user's app/state. */
export async function startDevApp(root) {
  root = resolve(root); mkdirSync(root, { recursive: true });
  const port = await freePort(), out = join(root, 'out'), logFile = join(root, 'dev.log');
  const env = { ...process.env, DATA_AGENT_HOME: join(root, 'data'), DATA_AGENT_USER_DATA: join(root, 'userData') };
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL', 'ELECTRON_ENTRY', 'ELECTRON_CLI_ARGS', 'DEEPSEEK_API_KEY', 'DATA_AGENT_TEST_MODEL_BASE_URL']) delete env[key];
  const fd = openSync(logFile, 'a');
  const child = spawn('pnpm', ['dev', '--outDir', out, '--entry', join(out, 'main/index.js'), '--remoteDebuggingPort', String(port), '--', '--data-agent-automation'], { env, detached: true, stdio: ['ignore', fd, fd] }); closeSync(fd);
  let exited = false, browser, page;
  const exit = new Promise(resolve => child.once('exit', () => { exited = true; resolve(); }));
  const errors = [];
  async function stop() {
    if (page && !page.isClosed()) {
      try { await page.screenshot({ path: join(root, 'final-screen.png') }); } catch {}
    }
    const meta = join(root, 'data/automation.json');
    if (!exited && existsSync(meta)) {
      try { process.kill(JSON.parse(readFileSync(meta, 'utf8')).pid, 'SIGTERM'); } catch {}
      await Promise.race([exit, delay(5000)]);
    }
    // Kill only the isolated process group created above, including the Vite server.
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    await Promise.race([exit, delay(2000)]);
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    try { await browser?.close(); } catch {}
  }
  try {
    const endpoint = await until(async () => {
      if (exited) throw new Error(`pnpm dev exited: ${readFileSync(logFile, 'utf8')}`);
      try { return await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch { return null; }
    }, 'Vite Electron CDP', 45000);
    browser = await chromium.connectOverCDP(endpoint.webSocketDebuggerUrl);
    page = await until(() => browser.contexts()[0]?.pages()[0], 'dev window');
    page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('textbox', { name: '分析需求' }).waitFor();
    return { page, browser, errors, stop, root, logFile };
  } catch (error) { await stop(); throw error; }
}
