import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../../components/ui/dialog';

export function RenameSessionDialog({
  initialTitle,
  rename,
  close,
}: {
  initialTitle: string;
  rename: (title: string) => Promise<void>;
  close: () => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    if (busy || !title.trim()) return;
    setBusy(true);
    setError('');
    try {
      await rename(title.trim());
      close();
    } catch (error) {
      setError(error instanceof Error ? error.message : '无法保存名称');
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
        <DialogTitle>重命名会话</DialogTitle>
        <DialogDescription className="mt-2 text-sm text-muted-foreground">
          为这个分析起一个容易找到的名字。
        </DialogDescription>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <input
            className="rename-input"
            aria-label="会话标题"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            maxLength={120}
            required
            disabled={busy}
          />
          {error && (
            <p role="alert" className="maintenance-error">
              {error}
            </p>
          )}
          <Button type="submit" disabled={busy || !title.trim()}>
            {busy ? '正在保存…' : '保存名称'}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
