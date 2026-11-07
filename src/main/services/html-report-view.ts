import { session, WebContentsView, type BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';
import type { HtmlReportState, ReportBounds } from '../../shared/html-report';

// This policy belongs exclusively to the unprivileged report, never the application renderer.
export const REPORT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";

/** A single immutable document, with no preload, filesystem mapping or application bridge. */
export function createHtmlReportView(
  window: BrowserWindow,
  html: string,
  onState: (state: HtmlReportState) => void,
  background = false,
) {
  const id = randomUUID();
  const url = `data-report://document/${id}`;
  const ses = session.fromPartition(`report-${id}`, { cache: false });
  let document: string | null = html;
  let closed = false;
  let status: HtmlReportState['status'] = 'loading';
  let notice: string | undefined;
  let published = '';
  const publish = () => {
    const key = `${status}:${notice ?? ''}`;
    if (closed || key === published) return;
    published = key;
    onState({ id, status, ...(notice ? { notice } : {}) });
  };
  const blocked = () => {
    if (notice) return;
    notice = '报告的外部资源或受限操作已被阻止；请生成自包含 HTML。';
    publish();
  };
  ses.setPermissionCheckHandler(() => false);
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.on('will-download', (event) => {
    event.preventDefault();
    blocked();
  });
  ses.webRequest.onBeforeRequest((details, callback) => {
    const allowed = !closed && details.url === url && details.resourceType === 'mainFrame';
    callback({ cancel: !allowed });
    if (!allowed) blocked();
  });
  ses.protocol.handle('data-report', (request) => {
    if (closed || request.url !== url || request.method !== 'GET' || document === null)
      return new Response(null, { status: 403 });
    return new Response(document, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': REPORT_CSP,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
  const view = new WebContentsView({
    webPreferences: {
      session: ses,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: !background,
      navigateOnDragDrop: false,
    },
  });
  view.setVisible(false);
  window.contentView.addChildView(view);
  const contents = view.webContents;
  // WebRTC can bypass webRequest/CSP. Disallow direct UDP and route proxy-aware
  // traffic to a closed local endpoint, including implicit loopback bypasses.
  contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  contents.setWindowOpenHandler(() => {
    blocked();
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event) => {
    event.preventDefault();
    blocked();
  });
  contents.on('will-frame-navigate', (event) => {
    event.preventDefault();
    blocked();
  });
  contents.on('will-redirect', (event) => {
    event.preventDefault();
    blocked();
  });
  contents.on('console-message', (details) => {
    if (details.level === 'error' || details.level === 'warning') {
      // Do not forward arbitrary document strings/data to the application or logs.
      notice = '报告脚本或资源出现错误，部分交互可能不可用；可查看源码或重新生成。';
      publish();
    }
  });
  contents.on('render-process-gone', () => {
    status = 'error';
    notice = '报告预览进程已退出，请重新打开。';
    publish();
  });
  contents.on('unresponsive', () => {
    status = 'error';
    notice = '报告未响应，可关闭预览或重新打开。';
    publish();
  });
  const ready = ses
    .setProxy({
      mode: 'fixed_servers',
      proxyRules: 'http://127.0.0.1:9',
      proxyBypassRules: '<-loopback>',
    })
    .then(() => {
      if (!closed) return contents.loadURL(url);
    })
    .then(() => {
      if (closed) return;
      status = 'ready';
      publish();
    })
    .catch(() => {
      status = 'error';
      notice = '无法加载 HTML 报告，请检查文件后重试。';
      publish();
    });
  return {
    id,
    view,
    ready,
    state: (): HtmlReportState => ({ id, status, ...(notice ? { notice } : {}) }),
    layout(bounds: ReportBounds, visible: boolean) {
      if (closed || window.isDestroyed()) return;
      const [width, height] = window.getContentSize();
      const x = Math.max(0, Math.min(width, Math.round(bounds.x)));
      const y = Math.max(0, Math.min(height, Math.round(bounds.y)));
      const w = Math.max(0, Math.min(width - x, Math.round(bounds.width)));
      const h = Math.max(0, Math.min(height - y, Math.round(bounds.height)));
      view.setBounds({ x, y, width: w, height: h });
      view.setVisible(visible && w > 0 && h > 0);
    },
    close() {
      if (closed) return;
      closed = true;
      document = null;
      if (!window.isDestroyed()) window.contentView.removeChildView(view);
      if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
      ses.protocol.unhandle('data-report');
      ses.webRequest.onBeforeRequest(null);
      ses.removeAllListeners('will-download');
    },
  };
}
