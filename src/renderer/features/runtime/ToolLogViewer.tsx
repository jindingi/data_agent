import { useState } from 'react';
import type { ToolLog, LogPage } from '../../../shared/maintenance';
import { request } from '../../lib/desktop';
import { Button } from '../../components/ui/button';

export function ToolLogViewer({
  sessionId,
  toolCallId,
}: {
  sessionId: string;
  toolCallId: string;
}) {
  const [logs, setLogs] = useState<ToolLog[]>([]),
    [selected, setSelected] = useState('');
  const [page, setPage] = useState<LogPage>(),
    [offsets, setOffsets] = useState<number[]>([]);
  const [listOffset, setListOffset] = useState(0),
    [nextListOffset, setNextListOffset] = useState<number | null>(null);
  const [opened, setOpened] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function load(logId: string, offset: number) {
    const value = await request({ type: 'logs.page', sessionId, logId, offset });
    setPage(value);
    setSelected(logId);
  }
  async function action(task: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await task();
    } catch (error) {
      setError(error instanceof Error ? error.message : '读取失败');
    } finally {
      setBusy(false);
    }
  }
  async function open(offset = 0) {
    setOpened(true);
    const value = await request({ type: 'logs.list', sessionId, toolCallId, offset });
    setLogs(value.logs);
    setListOffset(offset);
    setNextListOffset(value.nextOffset);
    setPage(undefined);
    if (value.logs[0]) {
      setOffsets([]);
      await load(value.logs[0].id, 0);
    }
  }
  if (!opened)
    return (
      <Button size="sm" variant="outline" onClick={() => void action(() => open())}>
        查看完整日志
      </Button>
    );
  return (
    <section className="tool-log" aria-label="完整工具日志">
      <div className="maintenance-actions">
        <strong>工具日志</strong>
        <Button size="sm" variant="ghost" onClick={() => setOpened(false)}>
          收起日志
        </Button>
      </div>
      <p className="maintenance-note">
        按页读取本机保存的输出；每次任务所有工具合计最多保留 10 MiB。
      </p>
      {logs.length > 1 && (
        <select
          aria-label="选择工具日志"
          value={selected}
          disabled={busy}
          onChange={(event) => {
            const id = event.target.value;
            void action(async () => {
              setOffsets([]);
              await load(id, 0);
            });
          }}
        >
          {logs.map((log, index) => (
            <option key={log.id} value={log.id}>
              执行记录 {logs.length - index}
            </option>
          ))}
        </select>
      )}
      {(listOffset > 0 || nextListOffset !== null) && (
        <div className="maintenance-actions">
          <Button
            size="sm"
            disabled={busy || listOffset === 0}
            onClick={() => void action(() => open(Math.max(0, listOffset - 100)))}
          >
            上一组记录
          </Button>
          <Button
            size="sm"
            disabled={busy || nextListOffset === null}
            onClick={() => void action(() => open(nextListOffset!))}
          >
            下一组记录
          </Button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {!busy && !logs.length && <p>未保存可读取的完整日志。</p>}
      {page && (
        <>
          <pre data-testid="full-tool-log">{page.text || '尚无输出'}</pre>
          <div className="maintenance-actions">
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !offsets.length}
              onClick={() =>
                void action(async () => {
                  const offset = offsets.at(-1)!;
                  await load(selected, offset);
                  setOffsets(offsets.slice(0, -1));
                })
              }
            >
              上一页日志
            </Button>
            <span>
              {page.offset.toLocaleString()} / {page.totalBytes.toLocaleString()} bytes
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || page.nextOffset === null}
              onClick={() =>
                void action(async () => {
                  await load(selected, page.nextOffset!);
                  setOffsets([...offsets, page.offset]);
                })
              }
            >
              下一页日志
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void action(() => load(selected, page.offset))}
            >
              刷新日志
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
