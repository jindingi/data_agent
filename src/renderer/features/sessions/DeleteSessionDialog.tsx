import { useEffect, useState } from 'react';
import type { DeletionPreview } from '../../../shared/maintenance';
import { request } from '../../lib/desktop';
import { Button } from '../../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../../components/ui/dialog';

export function DeleteSessionDialog({
  sessionId,
  close,
  deleted,
}: {
  sessionId: string;
  close: () => void;
  deleted: () => void;
}) {
  const [preview, setPreview] = useState<DeletionPreview>();
  const [outputs, setOutputs] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let mounted = true;
    void request({ type: 'sessions.deletePreview', sessionId })
      .then((value) => {
        if (mounted) {
          setPreview(value);
          setOutputs(value.deleteArtifacts);
        }
      })
      .catch((error) => {
        if (mounted) setError(error.message);
      });
    return () => {
      mounted = false;
    };
  }, [sessionId]);
  async function remove() {
    setBusy(true);
    setError('');
    try {
      const result = await request({
        type: 'sessions.delete',
        sessionId,
        deleteArtifacts: outputs,
      });
      if (result.complete) {
        deleted();
        return;
      }
      const value = await request({ type: 'sessions.deletePreview', sessionId });
      setPreview({ ...value, remaining: result.remaining });
      setOutputs(value.deleteArtifacts);
      setError('部分文件尚未清理。处理下方问题后可继续，已完成的清理不会重复。');
    } catch (error) {
      setError(error instanceof Error ? error.message : '删除失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogContent>
        <DialogTitle>删除会话</DialogTitle>
        <DialogDescription className="mt-2 text-sm text-muted-foreground">
          先停止此会话的任务，再删除会话记录与工具日志。原始 CSV、外部父目录和未登记文件会保留。
        </DialogDescription>
        {preview && (
          <>
            <label className="delete-choice">
              <input
                type="checkbox"
                checked={outputs}
                disabled={busy || preview.pending}
                onChange={(event) => setOutputs(event.target.checked)}
              />
              同时清理已登记产物（当前 {preview.artifactCount} 个）
            </label>
            <p className="maintenance-note">
              正在生成的产物会在任务停止后登记。保留产物时，你仍可通过 Finder
              访问工作区；会话记录删除后无法在工作台内恢复。
            </p>
            <p className="path-label">{preview.workspace}</p>
          </>
        )}
        {error && (
          <p role="alert" className="maintenance-error">
            {error}
          </p>
        )}
        {!!preview?.remaining.length && (
          <ul className="deletion-files">
            {preview.remaining.map((item) => (
              <li key={item.path}>
                <code>{item.path}</code>
                <p>{item.error ?? '待清理'}</p>
              </li>
            ))}
          </ul>
        )}
        <div className="maintenance-actions">
          <Button variant="outline" disabled={busy} onClick={close}>
            取消
          </Button>
          <Button variant="destructive" disabled={busy || !preview} onClick={() => void remove()}>
            {busy ? '正在停止并清理…' : preview?.pending ? '继续清理' : '确认删除会话'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
