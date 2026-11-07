import { useEffect, useRef, useState, type PointerEvent, type KeyboardEvent } from 'react';

const minimum = 420;
export function usePanelSize() {
  const ref = useRef<HTMLElement>(null);
  const [available, setAvailable] = useState(0);
  const [preferred, setPreferred] = useState(
    () => Number(localStorage.getItem('preview-width')) || 0,
  );
  useEffect(() => {
    const parent = ref.current!.parentElement!;
    const measure = () =>
      setAvailable(
        parent.clientWidth - (parent.querySelector('.sidebar')?.getBoundingClientRect().width ?? 0),
      );
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    const sidebar = parent.querySelector('.sidebar');
    if (sidebar) observer.observe(sidebar);
    measure();
    return () => observer.disconnect();
  }, []);
  // Observe sidebar toggles as well as native window resizing.
  useEffect(() => {
    const parent = ref.current!.parentElement!;
    const observer = new MutationObserver(() =>
      setAvailable(
        parent.clientWidth - (parent.querySelector('.sidebar')?.getBoundingClientRect().width ?? 0),
      ),
    );
    observer.observe(parent, { childList: true });
    return () => observer.disconnect();
  }, []);
  const maximum = Math.max(minimum, available - minimum);
  const width = Math.round(Math.max(minimum, Math.min(maximum, preferred || available * 0.45)));
  const overlay = available < minimum * 2;
  const update = (value: number) => {
    const next = Math.round(Math.max(minimum, Math.min(maximum, value)));
    setPreferred(next);
    localStorage.setItem('preview-width', String(next));
  };
  const pointer = useRef<{ x: number; width: number } | null>(null);
  return {
    ref,
    width,
    overlay,
    separator: {
      role: 'separator' as const,
      tabIndex: 0,
      'aria-label': '调整预览宽度',
      'aria-orientation': 'vertical' as const,
      'aria-valuemin': minimum,
      'aria-valuemax': maximum,
      'aria-valuenow': width,
      onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
        pointer.current = { x: event.clientX, width };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
      },
      onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
        if (pointer.current) update(pointer.current.width + pointer.current.x - event.clientX);
      },
      onPointerUp: (event: PointerEvent<HTMLDivElement>) => {
        pointer.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      },
      onPointerCancel: () => {
        pointer.current = null;
      },
      onKeyDown: (event: KeyboardEvent) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        update(
          event.key === 'Home'
            ? minimum
            : event.key === 'End'
              ? maximum
              : width + (event.key === 'ArrowLeft' ? 32 : -32),
        );
      },
    },
  };
}
