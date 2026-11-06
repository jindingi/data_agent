document.querySelector('#probe').onclick=async()=>{document.querySelector('#probe-output').textContent=JSON.stringify(await window.probeApi.probe());};
for(const id of ['A','B','C'])document.querySelector(`#start-${id}`).onclick=()=>window.probeApi.start(id);
document.querySelector('#stop-A').onclick=()=>window.probeApi.stop('A');
window.probeApi.onState(state=>document.querySelector('#state').textContent=JSON.stringify(state));
document.querySelector('#pi-smoke').onclick=async()=>{try{document.querySelector('#pi-result').textContent=JSON.stringify(await window.probeApi.piSmoke());}catch(error){document.querySelector('#pi-result').textContent=JSON.stringify({status:'failed',error:String(error)});}};
window.probeApi.onPiEvent(event=>document.querySelector('#pi-events').textContent+=JSON.stringify(event)+'\n');
