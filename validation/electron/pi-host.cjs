const {pathToFileURL}=require('node:url');
process.parentPort.on('message',async({data,ports})=>{
  const port=ports[0];port.start();
  try{
    const {runPiSmoke}=await import(pathToFileURL(data.modulePath).href);
    const result=await runPiSmoke(data.cwd,event=>port.postMessage({kind:'event',event}));
    port.postMessage({kind:'result',result});
  }catch(error){port.postMessage({kind:'error',error:String(error.stack)});}
});
