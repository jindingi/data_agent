process.parentPort.on('message',({data,ports})=>{
  const port=ports[0];let tick=0;port.start();
  setInterval(()=>port.postMessage({id:data.id,tick:++tick,pid:process.pid}),100);
});
