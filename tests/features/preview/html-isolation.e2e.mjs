import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createSocket } from 'node:dgram';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startApp, until } from '../../../scripts/test/harness.mjs';
import { createStoredSession, openWorkspaceFile, rpc } from '../../support/desktop.mjs';

export const cases = {
  async 'preview.html-isolation'({ dir }) {
    let requests = 0,
      packets = 0;
    const server = createServer((_req, res) => {
      requests++;
      res.end('forbidden');
    });
    server.on('upgrade', (_req, socket) => {
      requests++;
      socket.destroy();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const udp = createSocket('udp4');
    udp.on('message', () => packets++);
    await new Promise((resolve) => udp.bind(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    await fetch(origin); // prove the network observer works before testing denial
    udp.send(Buffer.from('probe'), udp.address().port, '127.0.0.1');
    await until(() => requests === 1 && packets === 1, 'network negative controls');
    requests = packets = 0;
    const app = await startApp(join(dir, 'html-isolation'));
    try {
      const stored = await createStoredSession(app.page);
      const html = `<!doctype html><meta charset="utf-8"><h1>Isolation fixture</h1>
<button id="popup" onclick="window.open('${origin}')">Popup</button>
<button id="navigate" onclick="location.href='${origin}'">Navigate</button>
<a id="download" href="data:text/plain,fixture" download="fixture.txt">Download</a>
<button id="error" onclick="throw new Error('PRIVATE_REPORT_DATA')">Error</button>
<script>
window.checks={bridge:typeof window.dataAgent,node:typeof require,eval:false};
try{new Function('return 1');checks.eval=true}catch{}
Promise.all([
fetch('${origin}').then(()=>true,()=>false),
fetch('file:///etc/hosts').then(()=>true,()=>false),
new Promise(r=>{try{const ws=new WebSocket('${origin.replace('http:', 'ws:')}');ws.onopen=()=>r(true);ws.onerror=()=>r(false)}catch{r(false)}}),
new Promise(r=>{navigator.geolocation.getCurrentPosition(()=>r(true),()=>r(false))}),
new Promise(r=>{try{const worker=new Worker('data:text/javascript,postMessage(1)');worker.onmessage=()=>r(true);worker.onerror=()=>r(false)}catch{r(false)}})
]).then(results=>checks.results=results);
const image=new Image();image.src='${origin}/image';document.body.append(image);
const frame=document.createElement('iframe');frame.src='${origin}/frame';document.body.append(frame);
const pc=new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:${udp.address().port}'}]});
pc.createDataChannel('probe');pc.createOffer().then(o=>pc.setLocalDescription(o));
pc.onicegatheringstatechange=()=>{if(pc.iceGatheringState==='complete'){checks.ice=true;pc.close()}};
setTimeout(()=>{checks.ice=true;pc.close()},3000);
</script>`;
      writeFileSync(join(stored.workspace, 'untrusted.html'), html);
      writeFileSync(join(stored.workspace, 'next.html'), '<!doctype html><h1>Next report</h1>');
      await openWorkspaceFile(app.page, 'untrusted.html');
      const pages = () => app.browser.contexts().flatMap((c) => c.pages());
      const report = await until(
        () => pages().find((p) => p.url().startsWith('data-report:')),
        'isolated page',
      );
      await until(
        () => report.evaluate(() => window.checks?.results && window.checks.ice),
        'restricted operations settle',
      );
      assert.deepEqual(await report.evaluate(() => window.checks.results), [
        false,
        false,
        false,
        false,
        false,
      ]);
      assert.equal(await report.evaluate(() => window.checks.bridge), 'undefined');
      assert.equal(await report.evaluate(() => window.checks.node), 'undefined');
      assert.equal(await report.evaluate(() => window.checks.eval), false);
      const url = report.url(),
        count = pages().length;
      const downloads = [];
      report.on('download', (download) => downloads.push(download));
      // Use real pointer input without Playwright waiting for denied navigations.
      const targets = await Promise.all(
        ['error', 'popup', 'download', 'navigate'].map((id) =>
          report.locator(`#${id}`).boundingBox(),
        ),
      );
      for (const box of targets) {
        assert(box);
        await report.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      }
      await app.page.getByRole('status').filter({ hasText: '报告脚本或资源出现错误' }).waitFor();
      assert.equal(report.url(), url);
      assert.equal(pages().length, count);
      for (const download of downloads)
        assert(await download.failure(), 'download must be canceled');
      assert.equal(requests, 0);
      assert.equal(packets, 0);
      assert(!(await app.page.innerText('body')).includes('PRIVATE_REPORT_DATA'));
      // The main UI stays responsive when untrusted JavaScript stops responding.
      void report
        .evaluate(() => {
          for (;;) {
            /* intentional hostile fixture */
          }
        })
        .catch(() => {});
      await openWorkspaceFile(app.page, 'next.html');
      await until(() => report.isClosed(), 'hung renderer destroyed', 8000);
      const next = await until(
        () => pages().find((p) => p.url().startsWith('data-report:') && p.url() !== url),
        'successor view',
      );
      await next.getByRole('heading', { name: 'Next report' }).waitFor();
      // A stale close capability cannot affect the successor.
      await rpc(app.page, { type: 'report.close', id: '00000000-0000-4000-8000-000000000001' });
      assert.equal(next.isClosed(), false);
      await rpc(app.page, { type: 'sessions.delete', sessionId: stored.id });
      await until(() => next.isClosed(), 'deleted session closes viewer');
      assert.deepEqual(app.errors, []);
      return {
        networkRequests: requests,
        rtcPackets: packets,
        blockedDownloads: downloads.length,
        hungViewClosed: true,
        permissionsDenied: true,
      };
    } finally {
      await app.stop();
      udp.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
};
