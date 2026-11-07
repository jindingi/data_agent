import { useState } from 'react';
import { ShieldQuestion, MessageCircleQuestion } from 'lucide-react';
import type { Interaction, InteractionAnswer } from '../../../shared/tools';
import { request } from '../../lib/desktop';
import { Button } from '../../components/ui/button';

export function InteractionCard({
  value,
  onError,
}: {
  value: Interaction;
  onError: (message: string) => void;
}) {
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(response: InteractionAnswer) {
    if (busy) return;
    setBusy(true);
    try {
      await request({
        type: 'interaction.answer',
        interactionId: value.id,
        sessionId: value.sessionId,
        runId: value.runId,
        hostEpoch: value.hostEpoch,
        digest: value.digest,
        answer: response,
      });
    } catch (error) {
      onError(error instanceof Error ? error.message : '无法提交回答');
      setBusy(false);
    }
  }
  return (
    <section
      className="interaction-card"
      data-interaction-id={value.id}
      aria-label={value.kind === 'approval' ? '安全审批' : '澄清问题'}
    >
      <h3>
        {value.kind === 'approval' ? (
          <ShieldQuestion size={17} />
        ) : (
          <MessageCircleQuestion size={17} />
        )}
        {value.title}
      </h3>
      <pre>{value.description}</pre>
      {value.kind === 'approval' ? (
        <>
          <p>仅批准显示的这一项操作；路径或脚本变化后需要重新确认。</p>
          <div className="interaction-actions">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void submit({ kind: 'approval', decision: 'allow_once' })}
            >
              允许这一次
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void submit({ kind: 'approval', decision: 'deny' })}
            >
              拒绝
            </Button>
          </div>
        </>
      ) : (
        <>
          {value.options.length > 0 && (
            <div className="question-options">
              {value.options.map((option) => (
                <button
                  key={option}
                  onClick={() => setAnswer(option)}
                  aria-pressed={answer === option}
                >
                  {option}
                </button>
              ))}
            </div>
          )}
          <textarea
            aria-label="澄清回答"
            rows={2}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            maxLength={4000}
            placeholder="选择建议或输入你的回答…"
          />
          <div className="interaction-actions">
            <Button
              size="sm"
              disabled={busy || !answer.trim()}
              onClick={() => void submit({ kind: 'clarification', answer: answer.trim() })}
            >
              提交回答
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void submit({ kind: 'clarification', answer: null })}
            >
              暂不回答
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
