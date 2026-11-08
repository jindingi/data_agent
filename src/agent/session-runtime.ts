import type { AgentBinding } from '../shared/agent-config';
import { bindAgentConfiguration } from './agent-configuration';
import { getCurrentSystemMessage } from '@earendil-works/pi-ai';
import { RequestBudget } from './request-budget';
import { TurnUsageLedger } from './turn-usage';
import { requestEvidence } from './request-evidence';
import { systemPrompt } from './runtime-context';
import { dirname } from 'node:path';
import {
  createExtensionRuntime,
  loadSkillsFromDir,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ContextEvent,
  type BeforeProviderRequestEvent,
  type MessageEndEvent,
  type ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import type { ModelChoice, RunInput, ThinkingLevel, RuntimeSnapshot } from '../shared/runtime';
import { AppError } from '../shared/errors';
import { inspectSessionFile } from '../node/session-integrity';
import { createWorkbenchSession } from './workbench-session';
import { createModelRuntime } from './models';
import { InputIdentity, trustedExtension, inputId, messageText } from './input-identity';
import { EventAdapter } from './event-adapter';
import { readTool } from './tools/read';
import { redactor } from './redact';
import { genericTools } from './tools';
import type { ToolExecutor } from './tool-client';
import type { Interaction } from '../shared/tools';

export interface RuntimeConfig {
  sessionId: string;
  runId: string;
  file: string;
  workspace: string;
  piSessionId: string | null;
  model: ModelChoice;
  thinkingLevel?: ThinkingLevel;
  apiKey: string;
  testBaseUrl?: string;
  baseUrl?: string;
  skillsDirectory?: string;
  agentConfig?: AgentBinding;
  protectedRoots: string[];
}
/** One Host, one native session writer. The caller owns admission and process lifetime. */
export class SessionRuntime {
  private running = false;
  private cancelled = false;
  private emitTimer: NodeJS.Timeout | undefined;
  private session!: AgentSession;
  private manager!: SessionManager;
  private identity!: InputIdentity;
  private adapter!: EventAdapter;
  private budget = new RequestBudget();
  private requestEvidence: NonNullable<RuntimeSnapshot['requests']> = [];
  private turnUsage!: TurnUsageLedger;
  private usage: RuntimeSnapshot['usage'];
  private responseModel: string | undefined;
  private redact = <T>(value: T): T => value;
  private interactions: Interaction[] = [];
  private outputDirectory: string | undefined;
  private unsubscribeTools: (() => void) | undefined;
  private constructor(private publish: (snapshot: RuntimeSnapshot) => void) {}
  static async create(
    config: RuntimeConfig,
    publish: (snapshot: RuntimeSnapshot) => void,
    dependencies?: {
      runtime?: ModelRuntime;
      fetch?: typeof fetch;
      tools?: ToolExecutor;
      onRequest?: (payload: unknown) => void;
      onContext?: (event: ContextEvent) => void;
    },
  ) {
    if (!config.apiKey.trim()) throw new AppError('MISSING_KEY', '请先配置所选提供方的 API key');
    const runtime = dependencies?.runtime ?? (await createModelRuntime());
    if (config.baseUrl)
      runtime.registerProvider(config.model.provider, { baseUrl: config.baseUrl });
    if (config.testBaseUrl) {
      const url = new URL(config.testBaseUrl);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password)
        throw new Error('Invalid test model endpoint');
      runtime.registerProvider(config.model.provider, { baseUrl: config.testBaseUrl });
    }
    const model = runtime.getModel(config.model.provider, config.model.model);
    if (!model) throw new AppError('UNKNOWN_MODEL', '所选模型不在内置模型列表中');
    await runtime.setRuntimeApiKey(model.provider, config.apiKey);
    const integrity = inspectSessionFile(
      config.file,
      config.piSessionId,
      Boolean(config.piSessionId),
    );
    if (!['draft', 'persisted'].includes(integrity.state))
      throw new AppError('HISTORY_UNAVAILABLE', integrity.error || '会话不可用');
    const instance = new SessionRuntime(publish);
    instance.outputDirectory = config.workspace;
    instance.manager = SessionManager.open(config.file, dirname(config.file), config.workspace);
    instance.identity = new InputIdentity(instance.manager);
    instance.turnUsage = new TurnUsageLedger(instance.manager);
    instance.adapter = new EventAdapter(config, instance.identity);
    instance.adapter.restore(instance.manager);
    const redact = redactor(config.apiKey);
    instance.redact = redact;
    const handlers = trustedExtension(
      new Map([
        [
          'message_end',
          [async (event: unknown) => ({ message: redact((event as MessageEndEvent).message) })],
        ],
        [
          'context',
          [
            async (event: unknown) => {
              const result = instance.identity.context(event as ContextEvent);
              dependencies?.onContext?.({ type: 'context', ...result });
              return result;
            },
          ],
        ],
        [
          'before_provider_request',
          [
            async (event: unknown) => {
              const payload = (event as BeforeProviderRequestEvent).payload;
              instance.recordRequest(payload);
              dependencies?.onRequest?.(payload);
            },
          ],
        ],
      ]),
    );
    const priorSystem = getCurrentSystemMessage(instance.manager.buildSessionProjection().messages);
    // Keep the native system prefix for resumed sessions. New attachments travel with
    // their user input; budgets are enforced at the transport boundary, never injected.
    const priorCwd = priorSystem?.sections?.cwd?.match(/^<cwd>\n([\s\S]*)\n<\/cwd>$/)?.[1];
    // Upgrade old run/version sessions once, by appending to history instead of rewriting
    // an already-sent system prefix. New sessions need no extra context messages.
    if (
      priorCwd &&
      priorCwd !== config.workspace &&
      !instance.manager
        .getEntries()
        .some(
          (entry) =>
            entry.type === 'custom_message' &&
            entry.customType === 'data_agent.workspace_migration',
        )
    ) {
      instance.manager.appendCustomMessageEntry(
        'data_agent.workspace_migration',
        `工作台目录规则已升级：本会话后续任务统一在 ${config.workspace} 工作并保存产物；历史中的 run/version 输出目录不再用于新产物。旧文件保留供读取。这是一次性目录迁移说明，不是新的用户任务。`,
        false,
      );
    }
    const registeredTools = dependencies?.tools
      ? genericTools(dependencies.tools, redact).filter(
          (tool) =>
            !config.agentConfig ||
            config.agentConfig.config.enabledTools.includes(
              tool.name as import('../shared/agent-config').ToolId,
            ),
        )
      : [readTool(config.workspace, config.protectedRoots)];
    if (config.agentConfig && !dependencies?.tools)
      throw new Error('Configured Agent requires a tool executor');
    const configured = config.agentConfig
      ? bindAgentConfiguration(
          instance.manager,
          config.agentConfig,
          priorCwd ?? config.workspace,
          registeredTools,
        )
      : undefined;
    const resources = {
      systemPrompt:
        configured?.prompt ??
        priorSystem?.sections?.preamble ??
        systemPrompt(config.workspace, Boolean(dependencies?.tools)),
      skills:
        configured?.skills ??
        (config.skillsDirectory
          ? loadSkillsFromDir({ dir: config.skillsDirectory, source: 'bundled' }).skills
          : []),
      extensions: { extensions: [handlers], errors: [], runtime: createExtensionRuntime() },
    };
    const { session } = await createWorkbenchSession({
      cwd: priorCwd ?? config.workspace,
      agentDir: dirname(config.file),
      sessionManager: instance.manager,
      modelRuntime: runtime,
      model,
      thinkingLevel: config.thinkingLevel ?? (model.reasoning ? 'high' : 'off'),
      settingsManager: SettingsManager.inMemory({
        retry: { enabled: true, maxRetries: 2 },
        compaction: { enabled: true },
        steeringMode: 'one-at-a-time',
        followUpMode: 'one-at-a-time',
        cacheWarming: 'off',
      }),
      resources,
      registeredTools,
    });
    instance.session = session;
    instance.unsubscribeTools = dependencies?.tools?.subscribe((interactions) => {
      const wasWaiting = instance.interactions.length > 0;
      instance.interactions = interactions;
      if (instance.running) {
        if (!wasWaiting && interactions.length) instance.pauseTimer();
        if (wasWaiting && !interactions.length) instance.startTimer();
        instance.adapter.state = interactions.some((item) => item.kind === 'approval')
          ? 'waiting_approval'
          : interactions.length
            ? 'waiting_input'
            : 'running';
        instance.flush();
      }
    });
    // Extension hooks report errors rather than enforcing transport cancellation. Gate the
    // public stream entry instead, so over-budget requests never reach the provider (including retries).
    const stream = session.agent.streamFunction;
    session.agent.streamFunction = (...args) => {
      try {
        instance.budget.consume();
      } catch (error) {
        instance.adapter.error = (error as Error).message;
        throw error;
      }
      const [selectedModel, context, options] = args;
      return stream(selectedModel, context, {
        ...options,
        ...(dependencies?.fetch ? { fetch: dependencies.fetch } : {}),
        maxTokens: Math.min(options?.maxTokens ?? 16_384, 16_384),
      });
    };
    session.subscribe((event) => {
      if (event.type === 'message_start' && event.message.role === 'user') {
        const id = inputId(messageText(event.message));
        if (id) instance.turnUsage.begin(id);
        instance.identity.consumed(event.message);
      }
      instance.adapter.accept(redact(event));
      if (event.type === 'turn_end' || event.type === 'agent_settled')
        instance.identity.reconcile();
      if (['turn_end', 'compaction_end', 'agent_settled'].includes(event.type))
        instance.turnUsage.refresh();
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        const modelError = '模型请求失败，请检查凭证、网络或模型额度后重试。';
        if (event.message.stopReason === 'error' && !instance.cancelled && !instance.adapter.error)
          instance.adapter.error = modelError;
        else if (event.message.stopReason !== 'error' && instance.adapter.error === modelError)
          instance.adapter.error = null;
        if (event.message.stopReason === 'length')
          instance.adapter.error = '模型输出达到长度上限，本轮已结束。';
      }
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        const { input, output, cacheRead, cacheWrite, totalTokens } = event.message.usage;
        const old = instance.usage;
        instance.usage = {
          input: input + (old?.input ?? 0),
          output: output + (old?.output ?? 0),
          cacheRead: cacheRead + (old?.cacheRead ?? 0),
          cacheWrite: cacheWrite + (old?.cacheWrite ?? 0),
          totalTokens: totalTokens + (old?.totalTokens ?? 0),
        };
        instance.responseModel = event.message.model;
      }
      instance.schedule();
    });
    return instance;
  }
  private recordRequest(payload: unknown) {
    const evidence = requestEvidence(payload, this.identity.known);
    this.requestEvidence.push(evidence);
    this.manager.appendCustomEntry('data_agent.request', evidence);
  }

  snapshot() {
    return this.redact({
      ...this.adapter.snapshot(),
      turnUsage: this.turnUsage.snapshot(),
      ...(this.outputDirectory ? { outputDirectory: this.outputDirectory } : {}),
      interactions: structuredClone(this.interactions),
      requests: structuredClone(this.requestEvidence),
      ...(this.usage ? { usage: { ...this.usage } } : {}),
      ...(this.responseModel ? { responseModel: this.responseModel } : {}),
    });
  }
  private pauseTimer() {
    this.budget.pause();
  }
  private startTimer() {
    this.budget.resume(() => {
      this.adapter.error = '任务超过 10 分钟活跃执行时限，已停止。';
      void this.cancel(true);
    });
  }
  private schedule() {
    this.emitTimer ??= setTimeout(() => {
      this.emitTimer = undefined;
      this.publish(this.snapshot());
    }, 40);
  }
  private flush() {
    clearTimeout(this.emitTimer);
    this.emitTimer = undefined;
    this.publish(this.snapshot());
  }
  async submit(input: RunInput) {
    if (input.kind !== 'prompt') {
      if (!this.running || this.cancelled)
        throw new AppError('NOT_RUNNING', '本次任务已结束，请作为新提问发送');
      await this.session[input.kind](this.identity.submit(input));
      this.flush();
      return;
    }
    if (this.running) throw new AppError('ALREADY_RUNNING', '该会话正在运行，请选择插话或后续提问');
    const text = this.identity.submit(input);
    this.turnUsage.begin(input.inputId);
    this.running = true;
    this.adapter.state = 'running';
    this.flush();
    this.startTimer();
    // The transport ACKs acceptance immediately; completion travels through the snapshot stream.
    void this.session
      .prompt(text, { expandPromptTemplates: false })
      .catch(() => {
        if (!this.cancelled) this.adapter.error ??= '任务执行失败，请检查模型设置后重试。';
      })
      .finally(() => {
        this.budget.pause();
        this.running = false;
        this.identity.settle(this.cancelled);
        this.adapter.restore(this.manager);
        this.adapter.activity = null;
        this.adapter.state = this.adapter.error
          ? 'failed'
          : this.cancelled
            ? 'cancelled'
            : 'completed';
        this.turnUsage.end(this.adapter.state);
        this.flush();
      });
  }
  async cancel(preserveError = false) {
    this.cancelled = true;
    if (!preserveError) this.adapter.error = null;
    this.session.clearQueue();
    await this.session.abort();
  }
  async dispose() {
    if (this.running) await this.cancel();
    this.budget.pause();
    clearTimeout(this.emitTimer);
    this.unsubscribeTools?.();
    this.session.dispose();
  }
}
