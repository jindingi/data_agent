const { app, BrowserWindow, ipcMain, utilityProcess, MessageChannelMain, safeStorage } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.VALIDATION_HOME;
if (!root) throw new Error('VALIDATION_HOME required');
app.setPath('userData', path.join(root, 'electron-user-data'));
const sessions = new Map();
let win, db, credentialProbe, seq = 0;
const python = app.isPackaged ? path.join(process.resourcesPath, 'python/bin/python3.12') : path.resolve(__dirname, '../runtime/python/cpython-3.12.12-macos-aarch64-none/bin/python3.12');
const supervisor = app.isPackaged ? path.join(process.resourcesPath, 'supervisor.py') : path.join(__dirname, 'supervisor.py');
function snapshot() { return [...sessions].map(([id,s]) => ({id,status:s.status,hostPid:s.host?.pid,events:s.events})); }
function notify() { if(win && !win.isDestroyed()) win.webContents.send('state', snapshot()); fs.writeFileSync(path.join(root,'state.json'), JSON.stringify(snapshot())); }
function pump() {
  let n = [...sessions.values()].filter(s => s.status === 'running').length;
  for(const [id,s] of sessions) {
    if(n>=2) break;
    if(s.status!=='queued') continue;
    n++; s.status='running';
    s.host=utilityProcess.fork(path.join(__dirname,'host.cjs'), [], {serviceName:`validation-${id}`,stdio:'pipe'});
    s.host.on('spawn',()=>{
      const {port1,port2}=new MessageChannelMain(); s.port=port1;
      port1.on('message', e=>{ if(e.data.id!==id) throw new Error('cross-session event'); s.events.push({...e.data,seq:++seq}); notify(); });
      port1.start(); s.host.postMessage({id},[port2]);
      const watchLog=fs.openSync(path.join(root,`${id}.watchdog.log`),'a');
      const watch=spawn(python,[supervisor,String(process.pid),String(s.host.pid),root,id], {detached:true,stdio:['pipe',watchLog,watchLog],env:{PATH:'/usr/bin:/bin',PYTHONDONTWRITEBYTECODE:'1'}});
      fs.closeSync(watchLog);watch.unref();s.watch=watch;s.watchPid=watch.pid;notify();
    });
    s.host.on('exit',()=>{s.status=s.status==='cancelled'?'cancelled':'interrupted'; s.port?.close(); notify(); pump();});
  }
  notify();
}
ipcMain.handle('probe',()=>({mainPid:process.pid,versions:process.versions,isPackaged:app.isPackaged,resourcesPath:process.resourcesPath,python,credentialProbe,resource:fs.readFileSync(app.isPackaged?path.join(process.resourcesPath,'resource-probe.txt'):path.join(__dirname,'resource-probe.txt'),'utf8').trim(),sqlite:db.prepare('select value from probe').get().value}));
ipcMain.handle('start',(_,id)=>{if(sessions.has(id))throw Error('duplicate');sessions.set(id,{status:'queued',events:[]});pump();return snapshot();});
ipcMain.handle('stop',(_,id)=>{const s=sessions.get(id);s.status='cancelled';s.host?.kill();notify();return snapshot();});
ipcMain.handle('pi-smoke',()=>new Promise((resolve,reject)=>{
  const host=utilityProcess.fork(path.join(__dirname,'pi-host.cjs'),[],{serviceName:'pi-sdk-validation',stdio:'pipe'});
  const timeout=setTimeout(()=>{host.kill();reject(Error('pi utilityProcess timeout'));},30000);
  host.on('spawn',()=>{
    const {port1,port2}=new MessageChannelMain();
    port1.on('message',({data})=>{
      if(data.kind==='event')win.webContents.send('pi-event',data.event);
      if(data.kind==='result'||data.kind==='error'){clearTimeout(timeout);port1.close();host.kill();data.kind==='result'?resolve(data.result):reject(Error(data.error));}
    });port1.start();
    host.postMessage({modulePath:app.isPackaged?path.join(process.resourcesPath,'pi/pi-smoke.mjs'):path.resolve(__dirname,'../pi/pi-smoke.mjs'),cwd:path.join(root,'pi-session')},[port2]);
  });
}));
app.whenReady().then(()=>{
  const sentinel='FAKE-KEY-validation-only';
  if(!safeStorage.isEncryptionAvailable()) throw new Error('safeStorage unavailable');
  const encrypted=safeStorage.encryptString(sentinel);fs.writeFileSync(path.join(root,'fake-credential.enc'),encrypted);
  credentialProbe={available:true,roundtrip:safeStorage.decryptString(encrypted)===sentinel,plaintextAbsent:!encrypted.includes(Buffer.from(sentinel))};
  const Database=require('better-sqlite3');db=new Database(path.join(root,'state.sqlite'));
  db.exec('CREATE TABLE probe(value TEXT NOT NULL)');db.prepare('INSERT INTO probe VALUES (?)').run('native-sqlite-ok');
  win=new BrowserWindow({width:1000,height:700,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
  win.loadFile(path.join(__dirname,'index.html'));
});
app.on('window-all-closed',()=>{});
app.on('before-quit',()=>{for(const s of sessions.values())s.host?.kill();db?.close();});
