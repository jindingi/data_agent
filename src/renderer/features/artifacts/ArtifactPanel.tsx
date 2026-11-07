import { usePanelSize } from './use-panel-size';
import * as Tabs from '@radix-ui/react-tabs';
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
  hidden,
  inputs,
  removeInput,
  close,
  onError,
}: {
  sessionId: string | null;
  hidden: boolean;
  inputs: FileReference[];
  removeInput: (id: string) => void;
  close: () => void;
  onError: (error: string) => void;
}) {
  const panelSize = usePanelSize();
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
    const current = ++generation.current;
    if (!sessionId) return;
    try {
      const next = await request({ type: 'artifacts.list', sessionId });
      if (current !== generation.current) return;
      setListing(next);
      if (latest.current !== next.versions[0]?.id) {
        const initial = !latest.current;
        latest.current = next.versions[0]?.id;
        setVersionId((previous) => previous ?? latest.current);
        if (initial && next.files.length) setTab('reports');
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
    <aside
      ref={panelSize.ref}
      hidden={hidden}
      style={{ width: expanded || panelSize.overlay ? undefined : panelSize.width }}
      className={`result-panel${expanded ? ' expanded' : ''}${panelSize.overlay ? ' overlay' : ''}`}
      aria-label="结果面板"
    >
      {!expanded && !panelSize.overlay && (
        <div className="panel-resizer" {...panelSize.separator} />
      )}
      <Tabs.Root
        value={tab}
        onValueChange={(value) => setTab(value as 'files' | 'reports')}
        className="artifact-tabs-root"
      >
        <div className="result-header">
          <Tabs.List className="tabs" aria-label="产物类别">
            <Tabs.Trigger value="files">文件</Tabs.Trigger>
            <Tabs.Trigger value="reports">预览</Tabs.Trigger>
          </Tabs.List>
          <span className="composer-spacer" />
          {sessionId && (
            <Button
              size="icon"
              variant="ghost"
              aria-label="打开工作区"
              onClick={() => {
                void request({ type: 'workspace.open', sessionId }).catch((error) =>
                  onError(error.message),
                );
              }}
            >
              <FolderOpen />
            </Button>
          )}
          {preview?.text !== undefined && (
            <Button
              size="icon"
              variant="ghost"
              aria-label="复制 Markdown"
              onClick={() => void copyReport()}
            >
              <Copy />
            </Button>
          )}
          {versionId && (
            <Button
              size="icon"
              variant="ghost"
              aria-label="导出这一版"
              disabled={
                exporting || listing.versions.find((v) => v.id === versionId)?.state !== 'published'
              }
              onClick={() => void exportFiles()}
            >
              <Download />
            </Button>
          )}
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
                  {new Date(version.createdAt).toLocaleString()}
                </option>
              ))}
            </select>

            {tab === 'reports' && files.length > 0 && (
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
          </div>
        )}
        {exported && (
          <p role="status" className="artifact-notice">
            已导出：{exported}
          </p>
        )}
        {copied && (
          <p role="status" className="artifact-notice">
            已复制 Markdown
          </p>
        )}
        {listing.versions.find((version) => version.id === versionId)?.error && (
          <p role="alert" className="artifact-notice">
            {listing.versions.find((version) => version.id === versionId)?.error}
          </p>
        )}
        <Tabs.Content value={tab} className="artifact-scroll" tabIndex={0}>
          {tab === 'files' ? (
            <>
              {inputs.length > 0 && (
                <div className="file-list">
                  {inputs.map((file) => (
                    <div key={file.id}>
                      <FileText size={17} />
                      <strong>{file.name}</strong>
                      <Button size="sm" variant="ghost" onClick={() => removeInput(file.id)}>
                        解除关联
                      </Button>
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
                  <h3>还没有预览</h3>
                  <p>选择一个已生成的文件以查看内容。</p>
                </div>
              )}
            </>
          )}
        </Tabs.Content>
      </Tabs.Root>
    </aside>
  );
}
