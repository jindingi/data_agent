const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('probeApi',{probe:()=>ipcRenderer.invoke('probe'),start:id=>ipcRenderer.invoke('start',id),stop:id=>ipcRenderer.invoke('stop',id),onState:callback=>ipcRenderer.on('state',(_,v)=>callback(v)),piSmoke:()=>ipcRenderer.invoke('pi-smoke'),onPiEvent:callback=>ipcRenderer.on('pi-event',(_,v)=>callback(v))});
