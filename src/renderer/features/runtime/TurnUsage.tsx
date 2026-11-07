import { Database } from 'lucide-react';
import { useId, useState, useRef, useEffect, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../../components/ui/button';
import type { TurnUsage as Usage } from '../../../shared/usage';

const number = new Intl.NumberFormat('en-US');
const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
export function TurnUsage({ usage, onInspect }: { usage: Usage; onInspect: () => void }) {
  const id = useId();
  const popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({ left: 16, top: 16, maxHeight: 400 });
  useEffect(() => {
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && popup.current?.contains(event.target)) return;
      if (popup.current?.matches(':popover-open')) popup.current.hidePopover();
    };
    window.addEventListener('resize', dismiss);
    document.addEventListener('scroll', dismiss, true);
    return () => {
      window.removeEventListener('resize', dismiss);
      document.removeEventListener('scroll', dismiss, true);
    };
  }, []);
  if (usage.status === 'running') return null;
  const input = usage.input + usage.cacheRead + usage.cacheWrite;
  const label = usage.complete ? '本轮用量' : '已记录用量';
  const tokens = (value: number) => `${number.format(value)} tok`;
  return (
    <div className="turn-usage" onPointerDown={onInspect} onKeyDown={onInspect}>
      <Button
        size="sm"
        variant="ghost"
        className="usage-trigger"
        tooltip="查看本轮用量"
        aria-label="查看本轮用量"
        aria-expanded={open}
        aria-controls={id}
        aria-haspopup="dialog"
        popoverTarget={id}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const width = Math.min(400, window.innerWidth - 32);
          const below = window.innerHeight - rect.bottom - 24;
          const above = rect.top - 24;
          const height = Math.min(460, Math.max(above, below));
          setPosition({
            left: Math.max(16, Math.min(rect.left, window.innerWidth - width - 16)),
            ...(below >= above
              ? { top: rect.bottom + 8 }
              : { bottom: window.innerHeight - rect.top + 8 }),
            maxHeight: height,
          });
        }}
      >
        <Database size={14} />
        {label} {usage.totalTokens ? `${compact.format(usage.totalTokens)} tok` : '未获取'}
      </Button>
      {createPortal(
        <div
          id={id}
          ref={popup}
          popover="auto"
          role="dialog"
          aria-label="本轮用量详情"
          tabIndex={-1}
          className="usage-popover"
          style={position}
          onToggle={(event) => {
            const next = event.newState === 'open';
            setOpen(next);
            if (next) event.currentTarget.focus({ preventScroll: true });
          }}
        >
          <div className="usage-heading">
            <strong>{label}</strong>
            <strong>{usage.totalTokens ? tokens(usage.totalTokens) : '未获取'}</strong>
          </div>
          <dl>
            <div>
              <dt>对话模型调用</dt>
              <dd>{usage.calls} 次</dd>
            </div>
            {usage.models.map((model) => (
              <div className="usage-model" key={`${model.provider}/${model.model}`}>
                <dt>{model.provider ? `${model.provider} / ${model.model}` : model.model}</dt>
                <dd>{tokens(model.totalTokens)}</dd>
              </div>
            ))}
            <div>
              <dt>缓存命中率</dt>
              <dd>{input ? `${((usage.cacheRead / input) * 100).toFixed(1)}%` : '—'}</dd>
            </div>
            <div>
              <dt>未缓存输入</dt>
              <dd>{tokens(usage.input)}</dd>
            </div>
            <div>
              <dt>缓存读取</dt>
              <dd>{tokens(usage.cacheRead)}</dd>
            </div>
            {usage.cacheWrite > 0 && (
              <div>
                <dt>缓存写入</dt>
                <dd>{tokens(usage.cacheWrite)}</dd>
              </div>
            )}
            <div>
              <dt>输出</dt>
              <dd>{tokens(usage.output)}</dd>
            </div>
            {usage.reasoning > 0 && (
              <div>
                <dt>其中已报告推理</dt>
                <dd>{tokens(usage.reasoning)}</dd>
              </div>
            )}
          </dl>
          {usage.compactions > 0 && <p>含 {usage.compactions} 次上下文摘要记录的用量。</p>}
          {!usage.complete && (
            <p>统计可能不完整：部分请求未返回用量，或历史记录缺少完整的轮次结束信息。</p>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
