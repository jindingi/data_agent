import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { chromium } from 'playwright-core';
import { freePort, until } from '../../../scripts/test/harness.mjs';
import { reportFixture } from '../../support/report-fixture.mjs';
const require = createRequire(import.meta.url);
export const cases = {
  async 'reports.engine'({ dir }) {
    const root = resolve(dir, 'report-engine');
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, 'viewer.cjs'),
      ts.transpileModule(readFileSync('src/main/services/html-report-view.ts', 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText,
    );
    const html = reportFixture(
      'comparison',
      `try { new Function('return 1'); window.evalAllowed=true; } catch { window.evalAllowed=false; }`,
    );
    writeFileSync(join(root, 'report.html'), html);
    writeFileSync(
      join(root, 'probe.cjs'),
      `const {app,BrowserWindow,protocol}=require('electron');const fs=require('node:fs');
const {createHtmlReportView}=require('./viewer.cjs');
app.setPath('userData',${JSON.stringify(join(root, 'userData'))});app.setActivationPolicy('accessory');
protocol.registerSchemesAsPrivileged([{scheme:'data-report',privileges:{standard:true,secure:true}}]);
app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1000,height:800,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,backgroundThrottling:false}});
await win.loadURL('data:text/html,<h1>Host</h1>');const report=createHtmlReportView(win,fs.readFileSync(${JSON.stringify(join(root, 'report.html'))},'utf8'),()=>{},true);report.layout({x:0,y:0,width:1000,height:760},true);});`,
    );
    const port = await freePort();
    const child = spawn(
      require('electron'),
      [
        join(root, 'probe.cjs'),
        `--remote-debugging-port=${port}`,
        '--remote-debugging-address=127.0.0.1',
      ],
      {
        env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
        stdio: 'ignore',
      },
    );
    const exit = new Promise((r) => child.once('exit', r));
    let browser;
    try {
      const endpoint = await until(async () => {
        try {
          return await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        } catch {
          return null;
        }
      }, 'probe CDP');
      browser = await chromium.connectOverCDP(endpoint.webSocketDebuggerUrl);
      const page = await until(
        () =>
          browser
            .contexts()
            .flatMap((c) => c.pages())
            .find((p) => p.url().startsWith('data-report:')),
        'report page',
      );
      await page.locator('canvas').waitFor();
      await page.getByLabel('地区').selectOption('east');
      assert.equal(await page.locator('#total').textContent(), '30');
      assert.equal(await page.locator('#rows').textContent(), '华东 30');
      await page.getByRole('button', { name: '重置' }).click();
      assert.equal(await page.locator('#total').textContent(), '60');
      assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
      assert.equal(await page.evaluate(() => typeof window.desktop), 'undefined');
      assert.equal(await page.evaluate(() => window.evalAllowed), false);
      assert.equal(
        await page.evaluate(async () => {
          try {
            await fetch('https://example.com/');
            return true;
          } catch {
            return false;
          }
        }),
        false,
      );
      await page.screenshot({ path: join(root, 'report.png') });
      return {
        version: '6.1.0',
        bytes: Buffer.byteLength(html),
        isolatedView: true,
        interactions: true,
      };
    } finally {
      child.kill('SIGTERM');
      await exit;
      await browser?.close();
    }
  },
};
