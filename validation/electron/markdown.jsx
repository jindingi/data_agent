import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Streamdown} from 'streamdown';
const chunks=['## Sales\n\n**North', '## Sales\n\n**North: -30%**\n\n```python\nprint(1)', '## Sales\n\n**North: -30%**\n\n```python\nprint(1)\n```\n\n![remote](https://example.invalid/tracker.png)\n\n[local](file:///etc/passwd)\n\n[bad](javascript:alert(1))\n\n<img src="https://example.invalid/raw.png" onerror="window.__injected=1">\n<script>window.__injected=1</script>'];
const safeComponents={img:({alt})=><span data-blocked-image>{alt||'image blocked'}</span>,a:({children})=><span data-blocked-link>{children}</span>};
function Probe(){const[i,setI]=useState(0);return <><button id="markdown-next" onClick={()=>setI(Math.min(i+1,chunks.length-1))}>Advance markdown stream</button><output id="markdown-stage">{i}</output><div id="markdown-output"><Streamdown mode="streaming" isAnimating={i<2} skipHtml rehypePlugins={[]} components={safeComponents} urlTransform={()=>undefined}>{chunks[i]}</Streamdown></div></>;}
createRoot(document.getElementById('markdown-root')).render(<Probe/>);
