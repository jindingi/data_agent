import { useMemo, useState, type ReactNode } from 'react';
import { Button } from '../../components/ui/button';

/** Keep large text out of the DOM while retaining every character in the projection. */
export function PagedText({
  text,
  children,
}: {
  text: string;
  children: (part: string) => ReactNode;
}) {
  const [requested, setRequested] = useState(0);
  const parts = useMemo(() => {
    const result: string[] = [];
    let start = 0;
    while (start < text.length) {
      let end = Math.min(start + 8192, text.length);
      if (end < text.length) {
        const newline = text.lastIndexOf('\n', end - 1);
        if (newline > start + 4096) end = newline + 1;
        const tail = text.charCodeAt(end - 1);
        if (tail >= 0xd800 && tail <= 0xdbff) end--;
      }
      result.push(text.slice(start, end));
      start = end;
    }
    return result.length ? result : [''];
  }, [text]);
  const index = Math.min(requested, parts.length - 1);
  return (
    <div className="paged-text">
      {children(parts[index])}
      {parts.length > 1 && (
        <nav className="maintenance-actions" aria-label="长文本分页">
          <Button
            size="sm"
            variant="outline"
            disabled={index === 0}
            onClick={() => setRequested(index - 1)}
          >
            上一段文字
          </Button>
          <span>
            第 {index + 1} / {parts.length} 段
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={index === parts.length - 1}
            onClick={() => setRequested(index + 1)}
          >
            下一段文字
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={index === parts.length - 1}
            onClick={() => setRequested(parts.length - 1)}
          >
            末段文字
          </Button>
        </nav>
      )}
    </div>
  );
}
