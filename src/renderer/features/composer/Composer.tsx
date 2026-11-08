import { useRef, useState, useLayoutEffect } from 'react';
import { FolderOpen, Table2, X, Plus, Sparkles, Settings2, ArrowUp } from 'lucide-react';
import { Button } from '../../components/ui/button';
import type { useComposer } from './use-composer';
import type { ModelController } from '../models/use-model-settings';
import type { RunInput, ThinkingLevel } from '../../../shared/runtime';
const thinkingLabels: Record<ThinkingLevel, string> = {
  off: '关闭思考',
  minimal: '最少思考',
  low: '低思考',
  medium: '中思考',
  high: '高思考',
  xhigh: '更高思考',
  max: '最高思考',
};
export function Composer({
  composer,
  modelSettings,
  hasSession,
  active,
  canSend,
  onSend,
  openSettings,
  onError,
}: {
  composer: ReturnType<typeof useComposer>;
  modelSettings: ModelController;
  hasSession: boolean;
  active: boolean;
  canSend: boolean;
  onSend: (kind: RunInput['kind']) => Promise<void>;
  openSettings: () => void;
  onError: (message: string) => void;
}) {
  const composing = useRef(false);
  const input = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    if (!input.current) return;
    input.current.style.height = 'auto';
    input.current.style.height = `${Math.min(150, Math.max(64, input.current.scrollHeight))}px`;
  }, [composer.draft.text]);
  const [inputKind, setInputKind] = useState<'steer' | 'followUp'>('steer');
  const models = modelSettings.value;
  const selectedModel = models?.models.find(
    (model) => model.provider === models.selected.provider && model.model === models.selected.model,
  );
  const run = (task: Promise<unknown>) => {
    void task.catch((error) => onError(error.message));
  };
  return (
    <>
      {!hasSession && (
        <Button
          variant="ghost"
          size="sm"
          className="workspace-hint"
          onClick={() => run(composer.chooseWorkspace())}
        >
          <FolderOpen size={14} />
          {composer.draft.parent
            ? `工作区：${composer.draft.parent.split('/').pop()}`
            : '选择工作区位置'}
        </Button>
      )}
      <div className="composer">
        {composer.draft.files.length > 0 && (
          <div className="attachment-list">
            {composer.draft.files.map((file) => (
              <span key={file.token} title={file.path}>
                <Table2 size={13} />
                <span>{file.name}</span>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`移除文件 ${file.name}`}
                  onClick={() => composer.removeFile(file.token)}
                >
                  <X size={12} />
                </Button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={input}
          aria-label="分析需求"
          placeholder="描述你的分析需求，或先添加 CSV 文件…"
          value={composer.draft.text}
          onChange={(e) => composer.setText(e.target.value)}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          onKeyDown={(event) => {
            if (
              event.key !== 'Enter' ||
              event.shiftKey ||
              composing.current ||
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229
            )
              return;
            event.preventDefault();
            if (!event.repeat) void onSend(active ? inputKind : 'prompt');
          }}
          rows={2}
        />
        <div className="composer-bottom">
          <Button
            size="icon"
            variant="ghost"
            aria-label="添加 CSV 文件"
            onClick={() => run(composer.pickFiles())}
          >
            <Plus />
          </Button>
          <span className="attachment-hint">CSV · 多文件</span>
          <div className="composer-spacer" />
          {active && (
            <select
              className="input-kind"
              aria-label="运行中输入方式"
              value={inputKind}
              onChange={(event) => setInputKind(event.target.value as 'steer' | 'followUp')}
            >
              <option value="steer">steer</option>
              <option value="followUp">followup</option>
            </select>
          )}
          {selectedModel?.reasoning && selectedModel.thinkingLevels.length > 1 && (
            <select
              className="composer-thinking"
              aria-label="输入区思考级别"
              title="用于之后提交的任务"
              value={models?.thinkingLevel}
              disabled={modelSettings.busy}
              onChange={(event) => {
                const level = event.target.value as ThinkingLevel;
                void modelSettings.change({ type: 'models.thinking', level });
              }}
            >
              {selectedModel.thinkingLevels.map((level) => (
                <option key={level} value={level}>
                  {thinkingLabels[level]}
                </option>
              ))}
            </select>
          )}
          <button className="model-button" onClick={() => openSettings()}>
            <Sparkles size={14} />
            {models?.configuredProviders.includes(models.selected.provider)
              ? (models.models.find(
                  (model) =>
                    model.provider === models.selected.provider &&
                    model.model === models.selected.model,
                )?.name ?? models.selected.model)
              : '配置模型'}
            <Settings2 size={13} />
          </button>
          <Button
            size="icon"
            aria-label="发送分析需求"
            disabled={!canSend}
            onClick={() => void onSend(active ? inputKind : 'prompt')}
            title="Enter 发送 · Shift+Enter 换行"
          >
            <ArrowUp />
          </Button>
        </div>
      </div>
      <div className="composer-caption">
        <span className="keyboard-hint">Enter 发送 · Shift+Enter 换行</span>
      </div>
      {modelSettings.error && (
        <p role="alert" className="maintenance-error">
          {modelSettings.error}
        </p>
      )}
    </>
  );
}
