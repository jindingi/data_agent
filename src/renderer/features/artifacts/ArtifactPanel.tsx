import { ZoomImage } from './ZoomImage';
import { Report } from './Report';
import { SourcePreview } from './SourcePreview';
import type { TextPreview } from '../../../shared/file-preview';
import { usePanelSize } from './use-panel-size';
import * as Tabs from '@radix-ui/react-tabs';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Copy,
  Code2,
  Download,
  Maximize2,
  Minimize2,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  X,
} from 'lucide-react';
import { request } from '../../lib/desktop';
import { Button } from '../../components/ui/button';
import type { FileReference } from '../../../shared/models';
import type { ArtifactListing, ArtifactPreview } from '../../../shared/artifacts';

export function ArtifactPanel({
  sessionId,
  hidden,
  inputs,
  workspace,
  removeInput,
  close,
  onError,
}: {
  sessionId: string | null;
  hidden: boolean;
  inputs: FileReference[];
  workspace: string | undefined;
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
  const [inputPreview, setInputPreview] = useState<TextPreview>();
  const [sourceMode, setSourceMode] = useState(false);
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
    setInputPreview(undefined);
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
  const chosenInput = inputs.find((file) => `input:${file.id}` === selected);
  const inputId = chosenInput?.id;
  const chosen = chosenInput
    ? undefined
    : (files.find((file) => file.id === selected) ??
      files.find((file) => file.kind === 'markdown') ??
      files.find((file) => file.kind === 'png') ??
      files[0]);
  const chosenId = chosen?.id;
  const chosenState = chosen?.state;
  const chosenHash = chosen?.sha256;
  useEffect(() => {
    let mounted = true;
    setPreview(undefined);
    setInputPreview(undefined);
    setSourceMode(false);
    setPreviewError('');
    setCopied(false);
    if (sessionId && inputId)
      void request({ type: 'files.preview', sessionId, fileId: inputId })
        .then((value) => {
          if (mounted) setInputPreview(value);
        })
        .catch((error) => {
          if (mounted) setPreviewError(error.message);
        });
    else if (sessionId && chosenId)
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
  }, [sessionId, chosenId, chosenState, chosenHash, inputId]);
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
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  async function copyReport() {
    if (!sessionId || (!chosen && !chosenInput)) return;
    try {
      if (chosenInput) await request({ type: 'files.copy', sessionId, fileId: chosenInput.id });
      else if (chosen) await request({ type: 'artifacts.copy', sessionId, artifactId: chosen.id });
      setCopied(true);
    } catch (error) {
      setPreviewError((error as Error).message);
    }
  }
  async function revealFile() {
    if (!sessionId) return;
    try {
      if (chosenInput) await request({ type: 'files.reveal', sessionId, fileId: chosenInput.id });
      else if (chosen)
        await request({ type: 'artifacts.reveal', sessionId, artifactId: chosen.id });
    } catch (error) {
      setPreviewError((error as Error).message);
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
              aria-label={
                tab === 'reports' && (chosen || chosenInput) ? '在 Finder 中定位文件' : '打开工作区'
              }
              onClick={() => {
                if (tab === 'reports' && (chosen || chosenInput)) {
                  void revealFile();
                  return;
                }
                void request({ type: 'workspace.open', sessionId }).catch((error) =>
                  onError(error.message),
                );
              }}
            >
              <FolderOpen />
            </Button>
          )}
          {tab === 'reports' &&
            (preview?.text !== undefined || inputPreview?.text !== undefined) && (
              <Button
                size="icon"
                variant="ghost"
                aria-label="复制当前内容"
                onClick={() => void copyReport()}
              >
                <Copy />
              </Button>
            )}
          {versionId && !chosenInput && (
            <Button
              size="icon"
              variant="ghost"
              aria-label="导出文件"
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
        {(listing.versions.length > 1 ||
          (tab === 'reports' && (files.length > 0 || inputs.length > 0))) && (
          <div className="artifact-toolbar">
            {listing.versions.length > 1 && !chosenInput && (
              <select
                aria-label="选择产物版本"
                value={versionId}
                onChange={(event) => {
                  setVersionId(event.target.value);
                  setSelected(undefined);
                  setExported('');
                }}
              >
                {listing.versions.map((version) => (
                  <option key={version.id} value={version.id}>
                    {version.directory === workspace
                      ? '会话文件'
                      : `历史版本 · ${new Date(version.createdAt).toLocaleString()}`}
                  </option>
                ))}
              </select>
            )}

            {tab === 'reports' && (files.length > 0 || inputs.length > 0) && (
              <select
                className="artifact-selector"
                aria-label="选择预览文件"
                title={chosenInput?.path ?? chosen?.relativePath}
                value={chosenInput ? `input:${chosenInput.id}` : (chosen?.id ?? '')}
                onChange={(event) => setSelected(event.target.value)}
              >
                <option value="" disabled>
                  选择文件
                </option>
                {inputs.length > 0 && (
                  <optgroup label="输入文件">
                    {inputs.map((file) => (
                      <option key={file.id} value={`input:${file.id}`}>
                        {file.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {files.length > 0 && (
                  <optgroup label="生成文件">
                    {files.map((file) => (
                      <option key={file.id} value={file.id}>
                        {file.relativePath}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            )}
            {tab === 'reports' && chosen?.kind === 'markdown' && preview?.text !== undefined && (
              <Button
                size="icon"
                variant="ghost"
                aria-label={sourceMode ? '查看渲染' : '查看源码'}
                aria-pressed={sourceMode}
                onClick={() => setSourceMode(!sourceMode)}
              >
                {sourceMode ? <FileText /> : <Code2 />}
              </Button>
            )}
          </div>
        )}
        {exported && (
          <p role="status" className="artifact-notice">
            已导出：{exported}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                if (sessionId)
                  void request({ type: 'artifacts.revealExport', sessionId, path: exported }).catch(
                    (error) => onError(error.message),
                  );
              }}
            >
              打开导出位置
            </Button>
          </p>
        )}
        {copied && (
          <p role="status" className="artifact-notice">
            已复制当前内容
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
                      <button
                        className="input-preview-link"
                        onClick={() => {
                          setSelected(`input:${file.id}`);
                          setTab('reports');
                        }}
                        aria-label={`预览 ${file.name}`}
                      >
                        <strong>{file.name}</strong>
                      </button>
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
              ) : chosenInput ? (
                inputPreview ? (
                  <SourcePreview preview={inputPreview} />
                ) : (
                  <p className="artifact-notice">正在读取文件…</p>
                )
              ) : preview ? (
                preview.artifact.state !== 'ready' ? (
                  <p className="artifact-notice">{preview.artifact.error || '无法展示该文件'}</p>
                ) : preview.image ? (
                  <ZoomImage src={preview.image} alt={preview.artifact.relativePath} />
                ) : preview.text !== undefined ? (
                  chosen?.kind === 'markdown' && !sourceMode ? (
                    <Report
                      preview={preview}
                      files={files}
                      choose={setSelected}
                      onError={onError}
                    />
                  ) : (
                    <SourcePreview
                      preview={{
                        ...preview,
                        language: chosen?.kind === 'markdown' ? 'markdown' : preview.language,
                      }}
                    />
                  )
                ) : (
                  <p className="artifact-notice">
                    {preview.notice || '暂不支持此文件格式，请在 Finder 中定位后打开。'}
                  </p>
                )
              ) : chosen ? (
                <p className="artifact-notice">正在读取产物…</p>
              ) : (
                <div className="result-empty">
                  <FileText size={30} />
                  <h3>还没有预览</h3>
                  <p>选择输入文件或生成文件以查看内容。</p>
                </div>
              )}
            </>
          )}
        </Tabs.Content>
      </Tabs.Root>
    </aside>
  );
}
