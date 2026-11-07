import { useCallback, useEffect, useRef, useState } from 'react';
import { Streamdown } from 'streamdown';
import {
  Copy,
  Download,
  Maximize2,
  Minimize2,
  ExternalLink,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  X,
} from 'lucide-react';
import { request } from '../../lib/desktop';
import { Button } from '../../components/ui/button';
import type { FileReference } from '../../../shared/models';
import type { ArtifactListing, ArtifactPreview, ArtifactRecord } from '../../../shared/artifacts';

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
  }, [file.id, file.sessionId]);
  return preview?.image ? (
    <img className="artifact-image" src={preview.image} alt={alt || file.relativePath} />
  ) : (
    <span className="artifact-notice">{error || preview?.artifact.error || '正在加载图片…'}</span>
  );
}
function Report({
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
  const file = preview.artifact;
  return (
    <div className="markdown-body artifact-markdown">
      <Streamdown
        mode="static"
        controls={false}
        skipHtml
        rehypePlugins={[]}
        urlTransform={(url) => url}
        components={{
          img: ({ src, alt }) => {
            const target = typeof src === 'string' ? localTarget(src, file, files) : undefined;
            return target?.kind === 'png' && target.state === 'ready' ? (
              <ArtifactImage file={target} alt={alt} />
            ) : (
              <span className="blocked-media">[图片未加载：{alt || '未登记或远程图片'}]</span>
            );
          },
          a: ({ href, children }) => {
            const target = href ? localTarget(href, file, files) : undefined;
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
                    void request({ type: 'link.open', url: href }).catch((error) =>
                      onError(error.message),
                    );
                  }}
                >
                  {children}
                  <ExternalLink size={11} />
                </button>
              );
            return <span>{children}</span>;
          },
        }}
      >
        {preview.text ?? ''}
      </Streamdown>
    </div>
  );
}
export function ArtifactPanel({
  sessionId,
  inputs,
  close,
  onError,
}: {
  sessionId: string | null;
  inputs: FileReference[];
  close: () => void;
  onError: (error: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [tab, setTab] = useState<'files' | 'reports'>('files');
  const [listing, setListing] = useState<ArtifactListing>({ versions: [], files: [] });
  const [versionId, setVersionId] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [preview, setPreview] = useState<ArtifactPreview>();
  const [previewError, setPreviewError] = useState('');
  const [exported, setExported] = useState('');
  const [exporting, setExporting] = useState(false);
  const generation = useRef(0),
    latest = useRef<string | undefined>(undefined);
  const refresh = useCallback(async () => {
    const current = generation.current;
    if (!sessionId) return;
    try {
      const next = await request({ type: 'artifacts.list', sessionId });
      if (current !== generation.current) return;
      setListing(next);
      if (latest.current !== next.versions[0]?.id) {
        latest.current = next.versions[0]?.id;
        setVersionId(latest.current);
        setSelected(undefined);
        if (next.files.length) setTab('reports');
      }
    } catch (error) {
      if (current === generation.current) onError((error as Error).message);
    }
  }, [sessionId, onError]);
  useEffect(() => {
    generation.current++;
    latest.current = undefined;
    setListing({ versions: [], files: [] });
    setSelected(undefined);
    setPreview(undefined);
    setExported('');
    setVersionId(undefined);
    void refresh();
    const unsubscribe = window.dataAgent.subscribe((event) => {
      if (event.type === 'artifacts.changed' && event.sessionId === sessionId) void refresh();
    });
    // This is an async generation counter, not a DOM ref: invalidate all outstanding requests.
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps -- Async ticket counter, intentionally invalidated at cleanup.
      generation.current++;
      unsubscribe();
    };
  }, [sessionId, refresh]);
  const files = listing.files.filter((file) => file.versionId === versionId);
  const chosen =
    files.find((file) => file.id === selected) ??
    files.find((file) => file.kind === 'markdown') ??
    files.find((file) => file.kind === 'png');
  const chosenId = chosen?.id;
  const chosenState = chosen?.state;
  useEffect(() => {
    let mounted = true;
    setPreview(undefined);
    setPreviewError('');
    setCopied(false);
    if (sessionId && chosenId)
      void request({ type: 'artifacts.preview', sessionId, artifactId: chosenId })
        .then((value) => {
          if (mounted) setPreview(value);
        })
        .catch((error) => {
          if (mounted) setPreviewError(error.message);
        });
    return () => {
      mounted = false;
    };
  }, [sessionId, chosenId, chosenState]);
  async function exportFiles() {
    if (!sessionId || !versionId) return;
    setExporting(true);
    try {
      const value = await request({
        type: 'artifacts.export',
        sessionId,
        versionId,
      });
      if (value) setExported(value);
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setExporting(false);
    }
  }
  async function copyReport() {
    if (!sessionId || !chosen) return;
    try {
      await request({ type: 'artifacts.copy', sessionId, artifactId: chosen.id });
      setCopied(true);
    } catch (error) {
      onError((error as Error).message);
    }
  }
  return (
    <aside className={`result-panel${expanded ? ' expanded' : ''}`} aria-label="结果面板">
      <div className="result-header">
        <strong>文件与产物</strong>
        <Button
          size="icon"
          variant="ghost"
          aria-label={expanded ? '缩小结果面板' : '展开结果面板'}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <Minimize2 /> : <Maximize2 />}
        </Button>
        <Button size="icon" variant="ghost" aria-label="关闭结果面板" onClick={close}>
          <X />
        </Button>
      </div>
      <div className="tabs" role="tablist" aria-label="产物类别">
        <button role="tab" aria-selected={tab === 'files'} onClick={() => setTab('files')}>
          文件
        </button>
        <button role="tab" aria-selected={tab === 'reports'} onClick={() => setTab('reports')}>
          报告
        </button>
      </div>
      {listing.versions.length > 0 && (
        <div className="artifact-toolbar">
          <select
            aria-label="选择产物版本"
            value={versionId}
            onChange={(event) => {
              setVersionId(event.target.value);
              setSelected(undefined);
              setExported('');
            }}
          >
            {listing.versions.map((version, index) => (
              <option key={version.id} value={version.id}>
                {index === 0 ? '最新 · ' : ''}
                {new Date(version.createdAt).toLocaleString()} · {version.id.slice(0, 6)}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="outline"
            disabled={
              exporting ||
              listing.versions.find((version) => version.id === versionId)?.state !== 'published'
            }
            onClick={() => void exportFiles()}
          >
            <Download size={13} />
            导出这一版
          </Button>
        </div>
      )}
      {sessionId && (
        <button
          className="open-workspace"
          onClick={() => {
            void request({ type: 'workspace.open', sessionId }).catch((error) =>
              onError(error.message),
            );
          }}
        >
          <FolderOpen size={13} />
          打开工作区
        </button>
      )}
      {exported && (
        <p role="status" className="artifact-notice">
          已导出：{exported}
        </p>
      )}
      {tab === 'reports' && preview?.text !== undefined && preview.artifact.state === 'ready' && (
        <div className="report-actions">
          <Button size="sm" variant="ghost" onClick={() => void copyReport()}>
            <Copy size={13} />
            复制 Markdown
          </Button>
          {copied && <span role="status">已复制 Markdown</span>}
        </div>
      )}
      {listing.versions.find((version) => version.id === versionId)?.error && (
        <p role="alert" className="artifact-notice">
          {listing.versions.find((version) => version.id === versionId)?.error}
        </p>
      )}
      <div className="artifact-scroll">
        {tab === 'files' ? (
          <>
            {inputs.length > 0 && (
              <div className="file-list">
                {inputs.map((file) => (
                  <div key={file.id}>
                    <FileText size={17} />
                    <strong>{file.name}</strong>
                    <span>{file.path}</span>
                    <small>
                      {file.missing
                        ? '原文件不可用'
                        : `${file.size.toLocaleString()} bytes · 原文件引用`}
                    </small>
                  </div>
                ))}
              </div>
            )}
            {files.length > 0 && (
              <div className="generated-files">
                {files.map((file) => (
                  <button
                    key={file.id}
                    onClick={() => {
                      setSelected(file.id);
                      setTab('reports');
                    }}
                  >
                    <span>
                      {file.kind === 'png' ? <ImageIcon size={16} /> : <FileText size={16} />}
                      {file.relativePath}
                    </span>
                    <small>
                      {file.size.toLocaleString()} bytes · {file.error || '已生成'}
                    </small>
                  </button>
                ))}
              </div>
            )}
            {!inputs.length && !files.length && (
              <div className="result-empty">
                <FolderOpen size={30} />
                <h3>还没有文件</h3>
                <p>添加的 CSV 与生成的文件会在这里汇集。</p>
              </div>
            )}
          </>
        ) : (
          <>
            {files.length > 0 && (
              <select
                className="artifact-selector"
                aria-label="选择报告或图表"
                value={chosen?.id ?? ''}
                onChange={(event) => setSelected(event.target.value)}
              >
                {files.map((file) => (
                  <option key={file.id} value={file.id}>
                    {file.relativePath}
                  </option>
                ))}
              </select>
            )}
            {previewError ? (
              <p className="artifact-notice" role="alert">
                {previewError}
              </p>
            ) : preview ? (
              preview.artifact.state !== 'ready' ? (
                <p className="artifact-notice">{preview.artifact.error || '无法展示该文件'}</p>
              ) : preview.image ? (
                <img
                  className="artifact-image"
                  src={preview.image}
                  alt={preview.artifact.relativePath}
                />
              ) : preview.text !== undefined ? (
                <Report preview={preview} files={files} choose={setSelected} onError={onError} />
              ) : (
                <p className="artifact-notice">该文件已生成，请导出或在工作区中查看。</p>
              )
            ) : chosen ? (
              <p className="artifact-notice">正在读取产物…</p>
            ) : (
              <div className="result-empty">
                <FileText size={30} />
                <h3>还没有报告</h3>
                <p>尚未生成可展示的报告或图表。Agent 结束执行不代表分析正确。</p>
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
