import { useEffect, useRef, useState } from 'react';
import type { WorkspaceEntry } from '../../../shared/workspace';
import type { HtmlReportState } from '../../../shared/html-report';
import { request } from '../../lib/desktop';

export function HtmlReport({
  entry,
  hidden,
  refresh,
}: {
  entry: WorkspaceEntry;
  hidden: boolean;
  refresh: number;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<HtmlReportState>();
  const [failure, setFailure] = useState('');
  useEffect(() => {
    const id = crypto.randomUUID();
    let active = true;
    let loaded = false;
    let frame = 0;
    let last = '';
    setState({ id, status: 'loading' });
    setFailure('');
    const layout = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const element = host.current;
        if (!active || !loaded || !element) return;
        const rect = element.getBoundingClientRect();
        const overlay = Array.from(
          document.querySelectorAll(
            '[role="dialog"], [role="alertdialog"], [role="menu"], [data-radix-popper-content-wrapper]',
          ),
        ).some((element) =>
          element.checkVisibility({ visibilityProperty: true, opacityProperty: true }),
        );
        const visible =
          !element.closest('[hidden]') && rect.width > 0 && rect.height > 0 && !overlay;
        const bounds = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        const next = JSON.stringify({ bounds, visible });
        if (last === next) return;
        last = next;
        void request({ type: 'report.layout', id, bounds, visible }).catch(() => {});
      });
    };
    const unsubscribe = window.dataAgent.subscribe((event) => {
      if (active && event.type === 'report.state' && event.state.id === id) setState(event.state);
    });
    const observer = new ResizeObserver(layout);
    if (host.current) observer.observe(host.current);
    const mutations = new MutationObserver(layout);
    mutations.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['hidden', 'data-state', 'style', 'class'],
    });
    window.addEventListener('resize', layout);
    window.addEventListener('scroll', layout, true);
    // Native popover state changes do not mutate DOM attributes observed above.
    document.addEventListener('toggle', layout, true);
    void request({ type: 'report.open', id, sessionId: entry.sessionId, entryId: entry.id })
      .then((value) => {
        if (!active) return;
        loaded = true;
        setState((previous) =>
          previous?.id === id && previous.status !== 'loading' ? previous : value,
        );
        layout();
      })
      .catch((error) => {
        if (active) setFailure(error.message);
      });
    return () => {
      active = false;
      cancelAnimationFrame(frame);
      unsubscribe();
      observer.disconnect();
      mutations.disconnect();
      window.removeEventListener('resize', layout);
      window.removeEventListener('scroll', layout, true);
      document.removeEventListener('toggle', layout, true);
      void request({ type: 'report.close', id }).catch(() => {});
    };
  }, [entry.id, entry.sessionId, refresh]);
  return (
    <section className="html-report" hidden={hidden} aria-label="HTML 交互报告">
      {failure ? (
        <p role="alert" className="artifact-notice">
          {failure}
        </p>
      ) : (
        <>
          {state?.status === 'loading' && (
            <p role="status" className="artifact-notice">
              正在加载交互报告…
            </p>
          )}
          {state?.notice && (
            <p role={state.status === 'error' ? 'alert' : 'status'} className="artifact-notice">
              {state.notice}
            </p>
          )}
        </>
      )}
      <div ref={host} className="html-report-surface" aria-label="报告内容" />
    </section>
  );
}
