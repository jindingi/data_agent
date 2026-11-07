import { _electron as electron } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/** Standalone Chromium file:// document, without the application's protocol or preload. */
export async function openOfflineReport(root, file) {
  root = resolve(root);
  mkdirSync(root, { recursive: true });
  const entry = join(root, 'browser.cjs');
  writeFileSync(
    entry,
    `const {app,BrowserWindow,session}=require('electron');
app.setPath('userData',${JSON.stringify(join(root, 'userData'))});
app.setActivationPolicy('accessory');
app.whenReady().then(()=>{session.defaultSession.enableNetworkEmulation({offline:true});
const win=new BrowserWindow({show:false,width:1000,height:750,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
win.loadFile(${JSON.stringify(resolve(file))});});`,
  );
  const browser = await electron.launch({
    executablePath: require('electron'),
    args: [entry],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
  });
  return { page: await browser.firstWindow(), close: () => browser.close() };
}
