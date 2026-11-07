import { ToolOperations } from './tool-operations';
import { PolicyService, digest, type PolicyContext } from './policy';
import { InteractionBroker } from './interactions';
import { ProcessRunner, type LogObserver } from '../../node/process-runner';
import { requireRuntime, type RuntimePaths } from '../../node/runtime-paths';
import type { ToolOperation, ToolResult, Interaction } from '../../shared/tools';

export interface ToolContext extends PolicyContext {
  sessionId: string;
  runId: string;
  hostEpoch: string;
  hostPid: number;
}
export interface ToolObservers {
  output(text: string): void;
  interaction(value: Interaction | null): void;
}
interface Active {
  runId: string;
  toolCallId: string;
  abort: AbortController;
}
export class ToolService {
  private active = new Set<Active>();
  private tails = new Map<string, Promise<unknown>>();
  private closed = new Set<string>();
  private operations: ToolOperations;
  readonly policy: PolicyService;
  readonly processes: ProcessRunner;
  constructor(
    private resources: RuntimePaths,
    logs: string,
    readonly broker: InteractionBroker,
    logObserver?: LogObserver,
  ) {
    this.policy = new PolicyService(resources);
    this.processes = new ProcessRunner(resources, logs, logObserver);
    this.operations = new ToolOperations(resources, this.processes);
  }
  execute(
    context: ToolContext,
    toolCallId: string,
    operation: ToolOperation,
    observers: ToolObservers,
  ): Promise<ToolResult> {
    const previous = this.tails.get(context.runId) ?? Promise.resolve();
    const item: Active = { runId: context.runId, toolCallId, abort: new AbortController() };
    this.active.add(item);
    const task = previous
      .catch(() => {})
      .then(async () => {
        try {
          if (this.closed.has(context.runId)) throw new Error('任务已结束');
          item.abort.signal.throwIfAborted();
          requireRuntime(this.resources);
          if (operation.name === 'ask_clarification') {
            const answer = await this.broker.request(
              {
                sessionId: context.sessionId,
                runId: context.runId,
                hostEpoch: context.hostEpoch,
                toolCallId,
                kind: 'clarification',
                digest: digest(operation),
                title: '需要补充信息',
                description: operation.question,
                options: operation.options ?? [],
              },
              item.abort.signal,
              observers.interaction,
            );
            return {
              output: JSON.stringify(answer),
              isError: answer.kind !== 'clarification' || answer.answer === null,
            };
          }
          const decision = await this.policy.inspect(context, operation);
          if (decision.decision === 'deny') throw new Error(decision.reasons.join('；'));
          const binding = digest({
            sessionId: context.sessionId,
            runId: context.runId,
            hostEpoch: context.hostEpoch,
            toolCallId,
            fingerprint: decision.fingerprint,
          });
          if (decision.decision === 'ask') {
            const description = [
              decision.reasons.join('；'),
              operation.name === 'bash'
                ? operation.command
                : `${operation.name}: ${operation.path}`,
              ...decision.paths.map((item) => `${item.action}: ${item.path}`),
              ...decision.scripts.map(
                (item) => `SHA256（JSON 编码脚本文本）${item.hash}: ${item.path}`,
              ),
              ...decision.network,
            ]
              .join('\n')
              .slice(0, 20_000);
            const answer = await this.broker.request(
              {
                sessionId: context.sessionId,
                runId: context.runId,
                hostEpoch: context.hostEpoch,
                toolCallId,
                kind: 'approval',
                digest: binding,
                title: '批准这一次操作？',
                description,
                options: [],
              },
              item.abort.signal,
              observers.interaction,
            );
            if (answer.kind !== 'approval' || answer.decision !== 'allow_once')
              throw new Error('用户拒绝了这一次操作，未执行');
          }
          item.abort.signal.throwIfAborted();
          const checked = await this.policy.inspect(context, operation);
          if (checked.fingerprint !== decision.fingerprint || checked.decision === 'deny')
            throw new Error('操作路径、脚本或规则结果已变化，原批准已失效，请重新调用工具');
          return await this.operations.execute(
            context,
            toolCallId,
            operation,
            item.abort.signal,
            observers,
            checked.paths[0]?.path,
          );
        } catch (error) {
          return {
            output: item.abort.signal.aborted
              ? '操作已取消'
              : error instanceof Error
                ? error.message
                : '工具执行失败',
            isError: true,
          };
        } finally {
          this.active.delete(item);
        }
      });
    this.tails.set(context.runId, task);
    void task.finally(() => {
      if (this.tails.get(context.runId) === task) this.tails.delete(context.runId);
    });
    return task;
  }
  cancelTool(runId: string, toolCallId: string) {
    for (const item of this.active)
      if (item.runId === runId && item.toolCallId === toolCallId) item.abort.abort();
  }
  cancelRun(runId: string) {
    this.closed.add(runId);
    for (const item of this.active) if (item.runId === runId) item.abort.abort();
    this.broker.cancelRun(runId);
  }
  async settled(runId?: string) {
    await Promise.allSettled(runId ? [this.tails.get(runId)] : [...this.tails.values()]);
  }
  releaseRun(runId: string) {
    if ([...this.active].some((item) => item.runId === runId))
      throw new Error('Cannot release active tools');
    this.closed.delete(runId);
    this.tails.delete(runId);
    this.processes.releaseRun(runId);
  }
  resourceCounts() {
    return {
      active: this.active.size,
      tails: this.tails.size,
      closed: this.closed.size,
      processBudgets: this.processes.runCount,
    };
  }
  stop() {
    for (const item of this.active) item.abort.abort();
    this.broker.stop();
    this.processes.stop();
  }
}
