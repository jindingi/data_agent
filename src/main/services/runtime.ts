import type { AgentConfigService } from './agent-config';
import type { AgentBinding } from '../../shared/agent-config';
import { frozenSkillPath } from '../../node/agent-config-resources';
import { resolve } from 'node:path';
import { submissionDigest } from '../../node/submission-digest';
import { RunLedger } from './runtime/run-ledger';
import { RunAdmission } from './runtime/admission';
import { RunLifecycle } from './runtime/lifecycle';
import { inspectFiles } from './file-selection';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { HostInput } from '../../shared/contracts/host';
import type { HostStatus } from '../../shared/contracts/ipc';
import type { ToolHandler } from './agent-process';
import type { ToolService } from './tools';
import type { CredentialService } from './credentials';
import type { SessionService } from './sessions';
import type { AppPaths } from '../../node/app-paths';
import { AppError } from '../../shared/errors';
import {
  isActive,
  terminalTools,
  type MessageView,
  type ModelChoice,
  type RunInput,
  type ThinkingLevel,
  type RuntimeSnapshot,
} from '../../shared/runtime';

export interface RuntimeHost {
  pid?: number | null;
  request(input: HostInput): Promise<unknown>;
  stop(): void;
  stopAndWait?(): Promise<void>;
}
type HostFactory = (
  status: (status: HostStatus) => void,
  snapshot: (snapshot: RuntimeSnapshot) => void,
  tool: ToolHandler,
  cancelTool: (toolCallId: string) => void,
) => RuntimeHost;
interface Task {
  agentConfig?: AgentBinding;
  thinkingLevel: ThinkingLevel;
  filePaths: string[];
  startPromise?: Promise<void>;
  stopPromise?: Promise<void>;
  finalizePromise?: Promise<void>;
  snapshot: RuntimeSnapshot;
  input: RunInput;
  model: ModelChoice;
  apiKey?: string;
  baseUrl?: string;
  host?: RuntimeHost;
  starting: boolean;
  outputDirectory?: string;
}
interface RuntimeDependencies {
  agentConfigs?: AgentConfigService;
  db: Database.Database;
  sessions: SessionService;
  credentials: CredentialService;
  paths: AppPaths;
  createHost: HostFactory;
  reader: { readHistory(file: string, workspace: string, piSessionId: string): Promise<unknown> };
  publish: (snapshot: RuntimeSnapshot) => void;
  changed: () => void;
  tools: ToolService;
  testBaseUrl?: string | undefined;
  skillsDirectory?: string | undefined;
}
/** Global admission only; pi owns each conversation's steer/follow-up queue. */
export class RuntimeService {
  private agentConfigs: AgentConfigService | undefined;
  private tasks = new Map<string, Task>();
  private admission = new RunAdmission<Task>(2);
  private ledger: RunLedger;
  private lifecycle: RunLifecycle;
  private recovered = new Map<string, RuntimeSnapshot>();
  private closing = false;
  private startingTasks = new Set<Promise<void>>();
  private db: Database.Database;
  private sessions: SessionService;
  private credentials: CredentialService;
  private paths: AppPaths;
  private createHost: HostFactory;
  private reader: {
    readHistory(file: string, workspace: string, piSessionId: string): Promise<unknown>;
  };
  private publish: (snapshot: RuntimeSnapshot) => void;
  private changed: () => void;
  private tools: ToolService;
  private testBaseUrl: string | undefined;
  private skillsDirectory: string | undefined;
  constructor(dependencies: RuntimeDependencies) {
    this.agentConfigs = dependencies.agentConfigs;
    this.db = dependencies.db;
    this.sessions = dependencies.sessions;
    this.credentials = dependencies.credentials;
    this.paths = dependencies.paths;
    this.createHost = dependencies.createHost;
    this.reader = dependencies.reader;
    this.publish = dependencies.publish;
    this.changed = dependencies.changed;
    this.tools = dependencies.tools;
    this.testBaseUrl = dependencies.testBaseUrl;
    this.skillsDirectory = dependencies.skillsDirectory;
    const { db, tools } = dependencies;
    this.ledger = new RunLedger(db);
    this.lifecycle = new RunLifecycle({ tools });
    db.prepare(
      "UPDATE sessions SET run_state='interrupted' WHERE run_state IN ('queued','starting','running','waiting_approval','waiting_input')",
    ).run();
    db.prepare("UPDATE input_submissions SET state='unknown' WHERE state='pending'").run();
  }
  activeStates(): Record<string, RuntimeSnapshot['state']> {
    return Object.fromEntries(
      [...this.tasks.values()]
        .filter((task) => isActive(task.snapshot.state))
        .map((task) => [task.snapshot.sessionId, task.snapshot.state]),
    );
  }
  snapshot(sessionId: string) {
    this.sessions.get(sessionId);
    const value = this.tasks.get(sessionId)?.snapshot ?? this.recovered.get(sessionId);
    return value ? this.ledger.withDrafts(value) : null;
  }
  discardDraft(sessionId: string, inputId: string) {
    const snapshot = this.snapshot(sessionId);
    if (!snapshot?.unsentInputs?.some((input) => input.inputId === inputId))
      throw new AppError('DRAFT_UNAVAILABLE', '只能移除该会话的未发送输入');
    this.db
      .prepare('UPDATE input_submissions SET pending_text=NULL,pending_paths=NULL WHERE input_id=?')
      .run(inputId);
  }
  private update(task: Task, snapshot: RuntimeSnapshot) {
    if (
      !isActive(task.snapshot.state) ||
      this.tasks.get(snapshot.sessionId) !== task ||
      task.snapshot.runId !== snapshot.runId ||
      snapshot.seq <= task.snapshot.seq
    )
      return;
    if (!isActive(snapshot.state))
      snapshot = {
        ...snapshot,
        activity: null,
        turnUsage: snapshot.turnUsage?.map((turn) =>
          turn.status === 'running'
            ? { ...turn, status: 'interrupted' as const, complete: false }
            : turn,
        ),
        interactions: [],
        messages: snapshot.messages.map((message) => ({ ...message, pending: false })),
        tools: snapshot.tools.map((tool) =>
          tool.status === 'running'
            ? { ...tool, status: 'failed', output: tool.output || '执行已结束，未收到完整工具结果' }
            : tool,
        ),
      };
    this.ledger.transition(task.snapshot, snapshot);
    snapshot = this.ledger.withDrafts(snapshot);
    task.snapshot = snapshot;
    this.publish(snapshot);
    if (!isActive(snapshot.state)) {
      task.apiKey = undefined;
      this.tools.cancelRun(snapshot.runId);
      const host = task.host;
      task.host = undefined;
      task.starting = false;
      task.stopPromise = host?.stopAndWait ? host.stopAndWait() : Promise.resolve(host?.stop());
      this.sessions.reconcile(snapshot.sessionId);
      this.changed();
      this.admission.remove(snapshot.runId);
      task.finalizePromise = this.lifecycle.finish(
        snapshot.runId,
        [task.stopPromise, task.startPromise],
        () => {
          this.admission.release(snapshot.runId);
          this.trimHistoryCache();
          this.pump();
        },
      );
    }
  }
  private submissions = new Map<
    string,
    Promise<{ sessionId: string; snapshot: RuntimeSnapshot }>
  >();
  submitConversation(input: RunInput, sessionId?: string, parent?: string) {
    const pending = this.submissions.get(input.inputId);
    if (pending)
      return pending.then(async (accepted) => {
        const receipt = this.db
          .prepare('SELECT digest FROM input_submissions WHERE input_id=?')
          .get(input.inputId) as { digest: string } | undefined;
        if (
          (sessionId && sessionId !== accepted.sessionId) ||
          receipt?.digest !== submissionDigest(input)
        )
          throw new AppError('INPUT_CONFLICT', '提交身份已用于不同内容');
        return accepted;
      });
    const task = this.acceptConversation(input, sessionId, parent);
    this.submissions.set(input.inputId, task);
    void task.finally(() => this.submissions.delete(input.inputId)).catch(() => {});
    return task;
  }
  private async acceptConversation(input: RunInput, sessionId?: string, parent?: string) {
    const receipt = this.db
      .prepare('SELECT session_id,digest FROM input_submissions WHERE input_id=?')
      .get(input.inputId) as { session_id: string; digest: string } | undefined;
    if (receipt) {
      if (
        (sessionId && sessionId !== receipt.session_id) ||
        receipt.digest !== submissionDigest(input)
      )
        throw new AppError('INPUT_CONFLICT', '提交身份已用于不同内容');
      const snapshot = await this.restoreSnapshot(receipt.session_id);
      if (!snapshot) throw new AppError('SUBMISSION_UNAVAILABLE', '已接收输入的运行状态不可用');
      return { sessionId: receipt.session_id, snapshot };
    }
    if (this.closing) throw new AppError('QUITTING', '应用正在退出');
    const model = this.credentials.selected();
    this.credentials.validate(model);
    this.credentials.key(model.provider);
    inspectFiles(input.paths ?? []);
    let id = sessionId;
    try {
      id ??= this.sessions.create(parent, input.inputId, true).id;
      const snapshot = await this.submit(id, input);
      this.db.prepare('UPDATE sessions SET creation_pending=0 WHERE id=?').run(id);
      if (!sessionId) this.sessions.rename(id, input.text.trim().slice(0, 48));
      this.changed();
      return { sessionId: id, snapshot };
    } catch (error) {
      const accepted = this.db
        .prepare('SELECT session_id FROM input_submissions WHERE input_id=?')
        .get(input.inputId) as { session_id: string } | undefined;
      if (accepted) {
        const snapshot = await this.restoreSnapshot(accepted.session_id);
        if (snapshot) return { sessionId: accepted.session_id, snapshot };
      }
      if (!sessionId) {
        // create() may have failed after recording its intent.
        const intent = this.db
          .prepare('SELECT id FROM sessions WHERE id=? AND creation_pending=1')
          .get(input.inputId);
        if (intent) this.sessions.rollbackEmpty(input.inputId);
      }
      throw error;
    }
  }
  async submit(sessionId: string, input: RunInput) {
    if (this.closing) throw new AppError('QUITTING', '应用正在退出');
    if (this.sessions.get(sessionId).state === 'deleting')
      throw new AppError('SESSION_UNAVAILABLE', '会话正在删除');
    const current = this.tasks.get(sessionId);
    if (current && isActive(current.snapshot.state)) {
      if (input.kind === 'prompt')
        throw new AppError('ALREADY_RUNNING', '会话已有任务，请使用 steer 或 followup');
      if (
        !current.host ||
        !['running', 'waiting_approval', 'waiting_input'].includes(current.snapshot.state)
      )
        throw new AppError('NOT_RUNNING', '任务尚在等待启动，请稍后使用 steer');
      const files = inspectFiles(input.paths ?? []);
      this.insertInput(
        current,
        input,
        files.map((file) => file.path),
      );
      current.filePaths = this.sessions.sources(sessionId);
      try {
        await current.host.request({ type: 'runtime.input', input });
      } catch (error) {
        this.db
          .prepare("UPDATE input_submissions SET state='unknown' WHERE input_id=?")
          .run(input.inputId);
        throw error;
      }
      return current.snapshot;
    }
    if (input.kind !== 'prompt')
      throw new AppError('NOT_RUNNING', '本次任务已结束，请作为新提问发送');
    // Preflight before allocating a run or a concurrency permit.
    const model = this.credentials.selected();
    this.credentials.validate(model);
    const apiKey = this.credentials.key(model.provider);
    const thinkingLevel = this.credentials.thinking(model);
    const baseUrl = this.credentials.endpoint(model.provider);
    this.sessions.reconcile(sessionId);
    const session = this.sessions.get(sessionId);
    if (session.archived || !['draft', 'persisted'].includes(session.state))
      throw new AppError('SESSION_UNAVAILABLE', session.error || '请先恢复会话后再提问');
    const agentConfig = this.agentConfigs?.require(sessionId);
    const files = inspectFiles(input.paths ?? []);

    let messages: MessageView[] = [];
    let turnUsage: RuntimeSnapshot['turnUsage'] = [];
    if (session.piSessionId && session.state === 'persisted') {
      const history = (await this.reader.readHistory(
        session.sessionFile,
        session.workspace,
        session.piSessionId,
      )) as { messages: MessageView[]; turnUsage?: RuntimeSnapshot['turnUsage'] };
      messages = history.messages;
      turnUsage = history.turnUsage ?? [];
    }
    await current?.finalizePromise;
    // A read RPC and prior inventory yield: recheck admission before creating another task for the same session.
    if (this.closing) throw new AppError('QUITTING', '应用正在退出');
    const latest = this.sessions.get(sessionId);
    if (latest.archived || !['draft', 'persisted'].includes(latest.state))
      throw new AppError('SESSION_UNAVAILABLE', '会话已归档或正在删除');
    if (isActive(this.tasks.get(sessionId)?.snapshot.state ?? 'completed'))
      throw new AppError('ALREADY_RUNNING', '该会话已有任务');
    const task: Task = {
      agentConfig,
      thinkingLevel,
      filePaths: [
        ...new Set([...this.sessions.sources(sessionId), ...files.map((file) => file.path)]),
      ],
      input,
      model,
      apiKey,
      baseUrl,
      starting: false,
      snapshot: {
        schemaVersion: 1,
        sessionId,
        runId: randomUUID(),
        seq: 0,
        state: 'queued',
        messages,
        turnUsage,
        tools: [],
        inputs: [{ inputId: input.inputId, kind: input.kind, state: 'pending' }],
        queuedInputs: [input],
        error: null,
      },
    };
    this.db.transaction(() => {
      this.db
        .prepare(`UPDATE sessions SET run_id=?,run_state='queued',run_error=NULL WHERE id=?`)
        .run(task.snapshot.runId, sessionId);
      this.insertInput(
        task,
        input,
        files.map((file) => file.path),
      );
      this.db
        .prepare('UPDATE sessions SET updated_at=? WHERE id=?')
        .run(new Date().toISOString(), sessionId);
    })();
    task.snapshot = this.ledger.withDrafts(task.snapshot);
    this.tasks.set(sessionId, task);
    this.admission.enqueue(task);
    this.publish(task.snapshot);
    this.changed();
    this.pump();
    return task.snapshot;
  }
  /** Rebuild a terminal projection from SQLite metadata and the native history, never replay input. */
  async restoreSnapshot(sessionId: string): Promise<RuntimeSnapshot | null> {
    const current = this.snapshot(sessionId);
    if (current) return current;
    const session = this.sessions.get(sessionId);
    const run = this.db
      .prepare(
        'SELECT run_id AS id,run_state AS state,run_error AS error FROM sessions WHERE id=? AND run_id IS NOT NULL',
      )
      .get(sessionId) as
      { id: string; state: RuntimeSnapshot['state']; error: string | null } | undefined;
    if (!run) return null;
    let messages: MessageView[] = [];
    let turnUsage: RuntimeSnapshot['turnUsage'] = [];
    if (session.state === 'persisted' && session.piSessionId) {
      const history = (await this.reader.readHistory(
        session.sessionFile,
        session.workspace,
        session.piSessionId,
      )) as {
        messages: MessageView[];
        inputs?: RuntimeSnapshot['inputs'];
        turnUsage?: RuntimeSnapshot['turnUsage'];
      };
      messages = history.messages;
      turnUsage = history.turnUsage ?? [];
      this.db.transaction(() => {
        for (const input of history.inputs ?? [])
          if (input.state === 'committed') {
            this.db
              .prepare(
                "UPDATE input_submissions SET state='committed',entry_id=?,pending_text=NULL,pending_paths=NULL WHERE input_id=? AND session_id=?",
              )
              .run(input.entryId, input.inputId, sessionId);
          }
      })();
    }
    if (this.tasks.has(sessionId)) return this.tasks.get(sessionId)!.snapshot;
    const inputs = this.db
      .prepare(
        'SELECT input_id AS inputId,kind,state,entry_id AS entryId FROM input_submissions WHERE run_id=? ORDER BY sequence',
      )
      .all(run.id) as (RuntimeSnapshot['inputs'][number] & { entryId: string | null })[];
    const snapshot: RuntimeSnapshot = {
      schemaVersion: 1,
      sessionId,
      runId: run.id,
      seq: 0,
      state: run.state,
      messages,
      tools: terminalTools(messages),
      turnUsage,
      inputs: inputs.map(({ entryId, ...input }) => ({
        ...input,
        ...(entryId ? { entryId } : {}),
      })),
      queuedInputs: [],
      interactions: [],
      activity: null,
      error:
        run.state === 'interrupted'
          ? '上次执行意外中断。已保留历史和已生成文件，未确认输入不会自动重发。'
          : run.error,
      outputDirectory: session.workspace,
    };
    this.recovered.set(sessionId, snapshot);
    this.trimHistoryCache();
    return this.ledger.withDrafts(snapshot);
  }
  private insertInput(task: Task, input: RunInput, sources: string[]) {
    this.ledger.accept(task.snapshot.runId, task.snapshot.sessionId, input, sources);
  }
  private pump() {
    if (this.closing) return;
    let task: Task | undefined;
    while ((task = this.admission.take())) {
      if (task.snapshot.state !== 'queued') {
        this.admission.release(task.snapshot.runId);
        continue;
      }
      task.starting = true;
      const start = this.start(task);
      task.startPromise = start;
      this.startingTasks.add(start);
      void start.finally(() => this.startingTasks.delete(start));
    }
  }
  private trimHistoryCache() {
    const terminal = [...this.tasks.entries()].filter(([, task]) => !isActive(task.snapshot.state));
    for (const [id] of terminal.slice(0, Math.max(0, terminal.length - 8))) this.tasks.delete(id);
    while (this.recovered.size > 8) this.recovered.delete(this.recovered.keys().next().value!);
  }
  private async start(task: Task) {
    const session = this.sessions.get(task.snapshot.sessionId);
    // Main's pre-start seq stays 0; the Host becomes the sole positive sequence producer.
    const starting: RuntimeSnapshot = { ...task.snapshot, state: 'starting' };
    this.ledger.transition(task.snapshot, starting);
    task.snapshot = starting;
    this.publish(task.snapshot);
    try {
      const apiKey = task.apiKey;
      if (!apiKey) throw new AppError('MISSING_KEY', '运行凭证已失效');
      task.outputDirectory = session.workspace;
      if (this.closing || task.snapshot.state !== 'starting') return;
      task.host = this.createHost(
        (status) => {
          if (status === 'exited' && isActive(task.snapshot.state) && !this.closing)
            this.fail(
              task,
              'Agent 进程异常退出，本轮已中断。未确认的输入不会自动重发。',
              'interrupted',
            );
        },
        (snapshot) => this.update(task, snapshot),
        async (toolCallId, operation, observers, maxOutputBytes) => {
          if (!task.host?.pid || !isActive(task.snapshot.state))
            return { output: '当前任务无法执行工具', isError: true };
          if (task.agentConfig && !task.agentConfig.config.enabledTools.includes(operation.name))
            return { output: `工具 ${operation.name} 在此会话中未启用`, isError: true };
          // Legacy skill locations remain in the prompt, but reads use frozen content.
          const readPath =
            operation.name === 'read'
              ? resolve(task.outputDirectory ?? session.workspace, operation.path)
              : undefined;
          const skill =
            operation.name === 'read' &&
            task.agentConfig?.skills.find((s) => s.filePath === readPath);
          if (skill && this.agentConfigs)
            operation = {
              ...operation,
              path: frozenSkillPath(
                this.agentConfigs.resourcesRoot,
                skill.bundleHash ?? skill.sha256,
                skill.id,
              ),
            } as typeof operation;
          return this.tools.execute(
            {
              sessionId: session.id,
              runId: task.snapshot.runId,
              hostPid: task.host.pid,
              workspace: session.workspace,
              workingDirectory: task.outputDirectory,
              protectedRoots: [
                this.paths.sessions,
                this.paths.database,
                `${this.paths.database}-wal`,
                `${this.paths.database}-shm`,
                this.paths.logs,
                join(this.paths.home, 'backups'),
              ],
              readonlyRoots: this.agentConfigs ? [this.agentConfigs.resourcesRoot] : [],
              inputs: task.filePaths,
            },
            toolCallId,
            operation,
            observers,
            maxOutputBytes,
          );
        },
        (toolCallId) => this.tools.cancelTool(task.snapshot.runId, toolCallId),
      );
      await task.host.request({
        type: 'runtime.start',
        config: {
          sessionId: session.id,
          runId: task.snapshot.runId,
          file: session.sessionFile,
          workspace: session.workspace,
          piSessionId: session.piSessionId,
          model: task.model,
          thinkingLevel: task.thinkingLevel,
          apiKey,
          skillsDirectory: this.skillsDirectory,
          ...(task.agentConfig ? { agentConfig: task.agentConfig } : {}),
          ...(task.baseUrl ? { baseUrl: task.baseUrl } : {}),
          ...(this.testBaseUrl ? { testBaseUrl: this.testBaseUrl } : {}),
          protectedRoots: [
            this.paths.sessions,
            this.paths.database,
            `${this.paths.database}-wal`,
            `${this.paths.database}-shm`,
            join(this.paths.home, 'logs'),
            join(this.paths.home, 'backups'),
          ],
        },
        input: task.input,
      });
      task.starting = false;
    } catch (error) {
      this.fail(
        task,
        error instanceof AppError && error.code === 'AGENT_CONFIG_UNAVAILABLE'
          ? error.message
          : '无法启动任务，请检查模型凭证或重新打开会话。',
      );
    } finally {
      task.apiKey = undefined;
    }
  }
  private fail(task: Task, error: string, state: 'failed' | 'interrupted' = 'failed') {
    if (!isActive(task.snapshot.state)) return;
    this.update(task, {
      ...task.snapshot,
      seq: task.snapshot.seq + 1,
      state,
      error,
      inputs: task.snapshot.inputs.map((input) =>
        input.state === 'pending' ? { ...input, state: 'unknown' } : input,
      ),
    });
  }
  async cancel(sessionId: string) {
    const task = this.tasks.get(sessionId);
    if (!task || !isActive(task.snapshot.state)) return;
    if (task.snapshot.state === 'queued' || task.snapshot.state === 'starting') {
      this.tools.cancelRun(task.snapshot.runId);
      this.update(task, {
        ...task.snapshot,
        seq: task.snapshot.seq + 1,
        state: 'cancelled',
        inputs: task.snapshot.inputs.map((input) => ({ ...input, state: 'cancelled' })),
      });
      await task.finalizePromise;
      return;
    }
    // Let the Host mark the SDK run cancelled before Main returns a cancelled tool result.
    // Its AbortSignal cancels Main's tool and waits for real process cleanup.
    try {
      await task.host?.request({ type: 'runtime.cancel' });
    } catch {
      this.tools.cancelRun(task.snapshot.runId);
      this.fail(task, '停止时 Agent 未响应，进程已结束。');
    }
    await task.finalizePromise;
  }
  /** Stop only this session and await its writers before deleting any registered paths. */
  async stopForDeletion(sessionId: string) {
    const task = this.tasks.get(sessionId);
    if (task) {
      await this.cancel(sessionId);
      if (isActive(task.snapshot.state))
        this.update(task, {
          ...task.snapshot,
          seq: task.snapshot.seq + 1,
          state: 'cancelled',
          inputs: task.snapshot.inputs.map((input) =>
            input.state === 'pending' ? { ...input, state: 'cancelled' } : input,
          ),
        });
      await Promise.allSettled([task.startPromise, task.stopPromise, task.finalizePromise]);
      await this.tools.settled(task.snapshot.runId);
    }
  }
  forget(sessionId: string) {
    const task = this.tasks.get(sessionId);
    if (task && isActive(task.snapshot.state)) throw new Error('Cannot forget an active session');
    if (task) this.admission.remove(task.snapshot.runId);
    this.tasks.delete(sessionId);
    this.recovered.delete(sessionId);
  }
  hostPid(sessionId: string) {
    return this.tasks.get(sessionId)?.host?.pid ?? null;
  }
  async stop() {
    this.closing = true;
    await Promise.allSettled([...this.tasks.keys()].map((id) => this.cancel(id)));
    this.tools.stop();
    for (const task of this.tasks.values()) {
      if (isActive(task.snapshot.state))
        this.update(task, {
          ...task.snapshot,
          seq: task.snapshot.seq + 1,
          state: 'cancelled',
          activity: null,
          interactions: [],
          inputs: task.snapshot.inputs.map((input) =>
            input.state === 'pending' ? { ...input, state: 'cancelled' } : input,
          ),
        });
      task.host?.stop();
      task.apiKey = undefined;
    }
    await Promise.allSettled([...this.startingTasks]);
    await this.lifecycle.settled();
    await this.tools.settled();
  }
}
