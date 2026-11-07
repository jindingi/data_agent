import { ZoomImage } from './ZoomImage';
import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { Streamdown } from 'streamdown';
import { ExternalLink } from 'lucide-react';
import { request } from '../../lib/desktop';
import type { ArtifactRecord, ArtifactPreview } from '../../../shared/artifacts';
function localTarget(href: string, report: ArtifactRecord, files: ArtifactRecord[]) {
  if (/^(?:[a-z][a-z\d+.-]*:|\/|\\)/i.test(href)) return undefined;
  let path: string;
  try {
    path = decodeURIComponent(href.split(/[?#]/)[0]);
  } catch {
    return undefined;
  }
  const parts = report.relativePath.split('/').slice(0, -1);
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return undefined;
      parts.pop();
    } else parts.push(part);
  }
  return files.find(
    (file) => file.versionId === report.versionId && file.relativePath === parts.join('/'),
  );
}
function ArtifactImage({ file, alt }: { file: ArtifactRecord; alt?: string }) {
  const [preview, setPreview] = useState<ArtifactPreview>();
  const [error, setError] = useState('');
  useEffect(() => {
    let mounted = true;
    setPreview(undefined);
    setError('');
    void request({
      type: 'artifacts.preview',
      sessionId: file.sessionId,
      artifactId: file.id,
    })
      .then((value) => {
        if (mounted) setPreview(value);
      })
      .catch((error) => {
        if (mounted) setError(error.message);
      });
    return () => {
      mounted = false;
    };
  }, [file.id, file.sessionId, file.sha256, file.state]);
  return preview?.image ? (
    <ZoomImage src={preview.image} alt={alt || file.relativePath} />
  ) : (
    <span className="artifact-notice">{error || preview?.artifact.error || '正在加载图片…'}</span>
  );
}
interface ReportContextValue {
  report: ArtifactRecord;
  files: ArtifactRecord[];
  choose: (id: string) => void;
  onError: (error: string) => void;
}
const ReportContext = createContext<ReportContextValue | null>(null);
function ReportImage({ src, alt }: { src?: string; alt?: string }) {
  const { report, files } = useContext(ReportContext)!;
  const target = src ? localTarget(src, report, files) : undefined;
  return target?.kind === 'png' && target.state === 'ready' ? (
    <ArtifactImage file={target} alt={alt} />
  ) : (
    <span className="blocked-media">[图片未加载：{alt || '未登记或远程图片'}]</span>
  );
}
function ReportLink({ href, children }: { href?: string; children?: ReactNode }) {
  const { report, files, choose, onError } = useContext(ReportContext)!;
  const target = href ? localTarget(href, report, files) : undefined;
  if (target)
    return (
      <button className="artifact-link" onClick={() => choose(target.id)}>
        {children}
      </button>
    );
  if (href && /^https?:\/\//i.test(href))
    return (
      <button
        className="artifact-link"
        onClick={() => {
          void request({ type: 'link.open', url: href }).catch((error) => onError(error.message));
        }}
      >
        {children}
        <ExternalLink size={11} />
      </button>
    );
  return <span>{children}</span>;
}
export function Report({
  preview,
  files,
  choose,
  onError,
}: {
  preview: ArtifactPreview;
  files: ArtifactRecord[];
  choose: (id: string) => void;
  onError: (error: string) => void;
}) {
  // Streamdown memoizes unchanged Markdown blocks. Resolve registered files through
  // context so new image hashes/availability update without remounting the document.
  return (
    <ReportContext.Provider value={{ report: preview.artifact, files, choose, onError }}>
      <div className="markdown-body artifact-markdown">
        <Streamdown
          mode="static"
          controls={false}
          skipHtml
          rehypePlugins={[]}
          urlTransform={(url) => url}
          components={{
            img: ({ src, alt }) => (
              <ReportImage src={typeof src === 'string' ? src : undefined} alt={alt} />
            ),
            a: ({ href, children }) => <ReportLink href={href}>{children}</ReportLink>,
          }}
        >
          {preview.text ?? ''}
        </Streamdown>
      </div>
    </ReportContext.Provider>
  );
}
