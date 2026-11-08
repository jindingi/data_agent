import { Button } from '../../components/ui/button';
import { InteractionCard } from './InteractionCard';
import { request } from '../../lib/desktop';
import { isActive, type RunInput, type RuntimeSnapshot } from '../../../shared/runtime';
export function RunControls({
  snapshot,
  restore,
  refresh,
  onError,
}: {
  snapshot: RuntimeSnapshot | null;
  restore: (input: RunInput) => Promise<void>;
  refresh: () => Promise<void>;
  onError: (message: string) => void;
}) {
  const active = snapshot ? isActive(snapshot.state) : false;
  const act = (task: Promise<unknown>) => {
    void task.catch((error) => onError(error.message));
  };
  return (
    <div className="run-controls">
      {' '}
      {snapshot?.interactions?.map((interaction) => (
        <InteractionCard key={interaction.id} value={interaction} onError={onError} />
      ))}
      {(snapshot?.queuedInputs ?? [])
        .filter(
          (input) =>
            input.kind !== 'prompt' ||
            !active ||
            snapshot?.state === 'queued' ||
            snapshot?.state === 'starting',
        )
        .map((input) => (
          <div className="queued-input" key={input.inputId}>
            <span>
              {active ? '等待处理' : '未发送'} ·{' '}
              {input.kind === 'steer' ? 'steer' : input.kind === 'followUp' ? 'followup' : '提问'}
            </span>
            <p>{input.text}</p>
            {!active && <button onClick={() => act(restore(input))}>放回输入框</button>}
          </div>
        ))}
      {(snapshot?.unsentInputs ?? []).map((input) => (
        <div className="queued-input" data-unsent-input={input.inputId} key={input.inputId}>
          <span>
            未发送 ·{' '}
            {input.kind === 'steer' ? 'steer' : input.kind === 'followUp' ? 'followup' : '提问'}
          </span>
          <p>{input.text}</p>
          <button onClick={() => act(restore(input))}>放回输入框</button>
          <button
            onClick={() =>
              act(
                request({
                  type: 'runtime.discardDraft',
                  sessionId: snapshot!.sessionId,
                  inputId: input.inputId,
                }).then(() => refresh()),
              )
            }
          >
            移除未发送输入
          </button>
        </div>
      ))}
      {snapshot && (
        <div className="run-status" role="status" data-run-state={snapshot.state}>
          <span>
            {
              {
                queued: '等待运行名额',
                starting: '正在连接模型',
                running: 'Agent 正在执行',
                waiting_approval: '等待你批准操作',
                waiting_input: '等待你补充信息',
                completed: '执行完成',
                cancelled: '已停止',
                failed: '本轮执行出错',
                interrupted: '上次执行已中断',
              }[snapshot.state]
            }
          </span>
          {snapshot.activity && (
            <small data-runtime-activity={snapshot.activity.kind}>
              {snapshot.activity.kind === 'retry'
                ? `模型请求重试中（${snapshot.activity.attempt}/${snapshot.activity.maxAttempts}）`
                : '正在压缩上下文，完整历史仍保留'}
            </small>
          )}
          {snapshot.inputs.filter((input) => input.state === 'pending' && input.kind !== 'prompt')
            .length > 0 && <small>有待处理输入</small>}
          {active && (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                act(request({ type: 'runtime.cancel', sessionId: snapshot!.sessionId }))
              }
            >
              停止
            </Button>
          )}
          {snapshot.error && <span role="alert">{snapshot.error}</span>}
        </div>
      )}
    </div>
  );
}
