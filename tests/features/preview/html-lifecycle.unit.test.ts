import { expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { WorkspaceFileService } from '../../../src/main/services/workspace';
import { HtmlReportService } from '../../../src/main/services/html-reports';
import { createHtmlReportView } from '../../../src/main/services/html-report-view';
vi.mock('../../../src/main/services/html-report-view', () => ({
  createHtmlReportView: vi.fn(() => ({
    state: () => ({ id: 'internal', status: 'loading' }),
    layout: vi.fn(),
    close: vi.fn(),
    ready: Promise.resolve(),
  })),
}));
it('serializes full reads, drops superseded requests and ignores stale viewer operations', async () => {
  let finish!: (value: string) => void;
  const html = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue('<h1>latest</h1>');
  const window = { isDestroyed: () => false } as unknown as BrowserWindow;
  const service = new HtmlReportService(
    () => window,
    { html } as unknown as WorkspaceFileService,
    () => {},
    true,
  );
  const first = service.open('first', 'session', 'one').catch((e) => e.message);
  await vi.waitFor(() => expect(html).toHaveBeenCalledOnce());
  const second = service.open('second', 'session', 'two').catch((e) => e.message);
  const last = service.open('last', 'session', 'three');
  expect(html).toHaveBeenCalledOnce();
  finish('<h1>stale</h1>');
  expect(await first).toBe('报告已关闭');
  expect(await second).toBe('报告已关闭');
  expect(await last).toEqual({ id: 'last', status: 'loading' });
  expect(html.mock.calls).toEqual([
    ['session', 'one'],
    ['session', 'three'],
  ]);
  expect(createHtmlReportView).toHaveBeenCalledOnce();
  const view = vi.mocked(createHtmlReportView).mock.results[0].value;
  const bounds = { x: 0, y: 0, width: 200, height: 300 };
  service.layout('first', bounds, true);
  service.close('second');
  service.closeSession('other');
  expect(view.layout).not.toHaveBeenCalled();
  expect(view.close).not.toHaveBeenCalled();
  service.layout('last', bounds, true);
  expect(view.layout).toHaveBeenCalledWith(bounds, true);
  service.closeSession('session');
  expect(view.close).toHaveBeenCalledOnce();
});
