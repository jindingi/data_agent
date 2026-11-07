import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { Streamdown } from 'streamdown';
import { request } from '../../lib/desktop';
import { ZoomImage } from '../artifacts/ZoomImage';
import type { WorkspaceEntry, WorkspacePreview } from '../../../shared/workspace';
interface Context {
  entry: WorkspaceEntry;
  choose: (entry: WorkspaceEntry) => void;
  onError: (message: string) => void;
}
const ReportContext = createContext<Context | null>(null);
const relativeLink = (value: string) => !/^(?:[a-z][a-z\d+.-]*:|\/|\\|#)/i.test(value);
function Image({ src, alt }: { src?: string; alt?: string }) {
  const { entry } = useContext(ReportContext)!;
  const [preview, setPreview] = useState<WorkspacePreview>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setPreview(undefined);
    setError('');
    if (!src || !relativeLink(src)) {
      setError('只展示工作区内的相对图片');
      return;
    }
    void request({
      type: 'workspace.resolve',
      sessionId: entry.sessionId,
      entryId: entry.id,
      href: src,
    })
      .then((file) =>
        request({ type: 'workspace.preview', sessionId: entry.sessionId, entryId: file.id }),
      )
      .then((value) => {
        if (active) setPreview(value);
      })
      .catch((error) => {
        if (active) setError(error.message);
      });
    return () => {
      active = false;
    };
  }, [entry.id, entry.sessionId, entry.modifiedAt, src]);
  return preview?.image ? (
    <ZoomImage src={preview.image} alt={alt || '报告图片'} />
  ) : (
    <span className="blocked-media">{error || preview?.notice || '正在读取图片…'}</span>
  );
}
function Link({ href, children }: { href?: string; children?: ReactNode }) {
  const { entry, choose, onError } = useContext(ReportContext)!;
  if (!href || (!relativeLink(href) && !/^https?:\/\//i.test(href))) return <span>{children}</span>;
  return (
    <button
      className="artifact-link"
      onClick={() => {
        void (
          relativeLink(href)
            ? request({
                type: 'workspace.resolve',
                sessionId: entry.sessionId,
                entryId: entry.id,
                href,
              }).then(choose)
            : request({ type: 'link.open', url: href })
        ).catch((error) => onError(error.message));
      }}
    >
      {children}
    </button>
  );
}
export function WorkspaceReport({
  preview,
  choose,
  onError,
}: {
  preview: WorkspacePreview;
  choose: Context['choose'];
  onError: Context['onError'];
}) {
  return (
    <ReportContext.Provider value={{ entry: preview.entry, choose, onError }}>
      <div className="markdown-body artifact-markdown">
        <Streamdown
          mode="static"
          controls={false}
          skipHtml
          rehypePlugins={[]}
          urlTransform={(url) => url}
          components={{
            img: ({ src, alt }) => (
              <Image src={typeof src === 'string' ? src : undefined} alt={alt} />
            ),
            a: ({ href, children }) => <Link href={href}>{children}</Link>,
          }}
        >
          {preview.text ?? ''}
        </Streamdown>
      </div>
    </ReportContext.Provider>
  );
}
