import type { BrowserWindow } from 'electron';
import type { HtmlReportState, ReportBounds } from '../../shared/html-report';
import { AppError } from '../../shared/errors';
import type { WorkspaceFileService } from './workspace';
import { createHtmlReportView } from './html-report-view';

/** Owns one view and its pending file read; stale opens/layout/close cannot affect a successor. */
export class HtmlReportService {
  private reads: Promise<void> = Promise.resolve();
  private current?: {
    id: string;
    sessionId: string;
    report?: ReturnType<typeof createHtmlReportView>;
  };
  constructor(
    private window: () => BrowserWindow | null,
    private files: WorkspaceFileService,
    private notify: (state: HtmlReportState) => void,
    private background: boolean,
  ) {}
  async open(id: string, sessionId: string, entryId: string): Promise<HtmlReportState> {
    this.close();
    const pending = { id, sessionId } as NonNullable<typeof this.current>;
    this.current = pending;
    try {
      const read = this.reads.then(() => {
        if (this.current !== pending) throw new AppError('REPORT_CLOSED', '报告已关闭');
        return this.files.html(sessionId, entryId);
      });
      // Bound full-document allocations even when the user rapidly switches files.
      this.reads = read.then(
        () => {},
        () => {},
      );
      const html = await read;
      const window = this.window();
      if (this.current !== pending || !window || window.isDestroyed())
        throw new AppError('REPORT_CLOSED', '报告已关闭');
      pending.report = createHtmlReportView(
        window,
        html,
        (state) => {
          if (this.current === pending) this.notify({ ...state, id });
        },
        this.background,
      );
      return { ...pending.report.state(), id };
    } catch (error) {
      if (this.current === pending) this.close(id);
      throw error;
    }
  }
  layout(id: string, bounds: ReportBounds, visible: boolean) {
    if (this.current?.id === id) this.current.report?.layout(bounds, visible);
  }
  close(id?: string) {
    if (id && this.current?.id !== id) return;
    const previous = this.current;
    this.current = undefined;
    previous?.report?.close();
  }
  closeSession(sessionId: string) {
    if (this.current?.sessionId === sessionId) this.close();
  }
}
