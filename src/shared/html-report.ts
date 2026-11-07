export const HTML_REPORT_MAX_BYTES = 32 * 1024 * 1024;
export interface HtmlReportState {
  id: string;
  status: 'loading' | 'ready' | 'error';
  notice?: string;
}
export interface ReportBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
