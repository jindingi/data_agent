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
import type { ArtifactService } from './artifacts';
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
  thinkingLevel: ThinkingLevel;
  filePaths: string[];
  startPromise?: Promise<void>;
  stopPromise?: Promise<void>;
  finalizePromise?: Promise<void>;
  snapshot: RuntimeSnapshot;
  input: RunInput;
  model: ModelChoice;
  apiKey?: string;
  host?: RuntimeHost;
  starting: boolean;
  outputDirectory?: string;
  versionId?: string;
}
interface RuntimeDependencies {
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
  artifacts: ArtifactService;
  skillsDirectory?: string | undefined;
}
/** Global admission only; pi owns each conversation's steer/follow-up queue. */
export class RuntimeService {
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
  private artifacts: ArtifactService;
  private skillsDirectory: string | undefined;
  constructor(dependencies: RuntimeDependencies) {
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
    this.artifacts = dependencies.artifacts;
    this.skillsDirectory = dependencies.skillsDirectory;
    const { db, tools, artifacts } = dependencies;
    this.ledger = new RunLedger(db);
    this.lifecycle = new RunLifecycle({ tools, artifacts });
    db.prepare(
      "UPDATE runs SET state='interrupted',ended_at=? WHERE state IN ('queued','starting','running','waiting_approval','waiting_input')",
    ).run(new Date().toISOString());
    db.prepare("UPDATE run_inputs SET state='unknown' WHERE state='pending'").run();
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
    this.db.prepare('DELETE FROM input_drafts WHERE input_id=?').run(inputId);
  }
  private update(task: Task, snapshot: RuntimeSnapshot) {
    if (
      !isActive(task.snapshot.state) ||
      this.tasks.get(snapshot.sessionId) !== task ||
      task.snapshot.hostEpoch !== snapshot.hostEpoch ||
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
        task.versionId,
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
          .prepare('SELECT digest FROM submission_receipts WHERE input_id=?')
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
      .prepare('SELECT session_id,digest FROM submission_receipts WHERE input_id=?')
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
    inspectFiles([
      ...(sessionId ? this.sessions.files(sessionId).map((f) => f.path) : []),
      ...(input.paths ?? []),
    ]);
    let id = sessionId;
    try {
      id ??= this.sessions.create(parent, input.inputId, true).id;
      const snapshot = await this.submit(id, input);
      this.db.prepare('DELETE FROM conversation_intents WHERE session_id=?').run(id);
      if (!sessionId) this.sessions.rename(id, input.text.trim().slice(0, 48));
      this.changed();
      return { sessionId: id, snapshot };
    } catch (error) {
      const accepted = this.db
        .prepare('SELECT session_id FROM submission_receipts WHERE input_id=?')
        .get(input.inputId) as { session_id: string } | undefined;
      if (accepted) {
        const snapshot = await this.restoreSnapshot(accepted.session_id);
        if (snapshot) return { sessionId: accepted.session_id, snapshot };
      }
      if (!sessionId) {
        // create() may have failed after recording its intent.
        const intent = this.db
          .prepare('SELECT session_id FROM conversation_intents WHERE session_id=?')
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
        throw new AppError('ALREADY_RUNNING', '会话已有任务，请使用插话或后续提问');
      if (
        !current.host ||
        !['running', 'waiting_approval', 'waiting_input'].includes(current.snapshot.state)
      )
        throw new AppError('NOT_RUNNING', '任务尚在等待启动，请稍后插话');
      inspectFiles([
        ...this.sessions.files(sessionId).map((file) => file.path),
        ...(input.paths ?? []),
      ]);
      this.insertInput(current, input);
      this.sessions.addFiles(sessionId, input.paths ?? []);
      current.filePaths = this.sessions.files(sessionId).map((file) => file.path);
      try {
        await current.host.request({ type: 'runtime.input', input });
      } catch (error) {
        this.db.prepare("UPDATE run_inputs SET state='unknown' WHERE id=?").run(input.inputId);
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
    this.sessions.reconcile(sessionId);
    const session = this.sessions.get(sessionId);
    if (session.archived || !['draft', 'persisted'].includes(session.state))
      throw new AppError('SESSION_UNAVAILABLE', session.error || '请先恢复会话后再提问');
    const existingFiles = this.sessions.files(sessionId);
    const files = inspectFiles([...existingFiles.map((file) => file.path), ...(input.paths ?? [])]);

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
      thinkingLevel,
      filePaths: files.map((file) => file.path),
      input,
      model,
      apiKey,
      starting: false,
      snapshot: {
        schemaVersion: 1,
        sessionId,
        runId: randomUUID(),
        hostEpoch: randomUUID(),
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
        .prepare('INSERT INTO runs VALUES (?,?,?,?,?,?,?,NULL)')
        .run(
          task.snapshot.runId,
          sessionId,
          task.snapshot.hostEpoch,
          'queued',
          model.provider,
          model.model,
          new Date().toISOString(),
        );
      for (const file of files)
        this.db
          .prepare('INSERT INTO run_files(run_id,path,size) VALUES (?,?,?)')
          .run(task.snapshot.runId, file.path, file.size);
      this.insertInput(task, input);
      this.sessions.addFiles(sessionId, input.paths ?? []);
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
        'SELECT id,host_epoch,state FROM runs WHERE session_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',
      )
      .get(sessionId) as
      { id: string; host_epoch: string; state: RuntimeSnapshot['state'] } | undefined;
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
            const result = this.db
              .prepare(
                "UPDATE run_inputs SET state='committed',entry_id=? WHERE id=? AND run_id IN (SELECT id FROM runs WHERE session_id=?)",
              )
              .run(input.entryId, input.inputId, sessionId);
            if (result.changes)
              this.db.prepare('DELETE FROM input_drafts WHERE input_id=?').run(input.inputId);
          }
      })();
    }
    if (this.tasks.has(sessionId)) return this.tasks.get(sessionId)!.snapshot;
    const inputs = this.db
      .prepare(
        'SELECT id AS inputId,kind,state,entry_id AS entryId FROM run_inputs WHERE run_id=? ORDER BY rowid',
      )
      .all(run.id) as (RuntimeSnapshot['inputs'][number] & { entryId: string | null })[];
    const output = this.db
      .prepare(
        'SELECT directory FROM output_versions WHERE run_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1',
      )
      .get(run.id) as { directory: string } | undefined;
    const snapshot: RuntimeSnapshot = {
      schemaVersion: 1,
      sessionId,
      runId: run.id,
      hostEpoch: run.host_epoch,
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
          : null,
      ...(output ? { outputDirectory: output.directory } : {}),
    };
    this.recovered.set(sessionId, snapshot);
    this.trimHistoryCache();
    return this.ledger.withDrafts(snapshot);
  }
  private insertInput(task: Task, input: RunInput) {
    this.ledger.accept(task.snapshot.runId, task.snapshot.sessionId, input);
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
      const version = await this.artifacts.openWorkspace(session.id, task.snapshot.runId);
      task.versionId = version.id;
      task.outputDirectory = version.directory;
      if (this.closing || task.snapshot.state !== 'starting') {
        void this.artifacts.publish(version.id);
        return;
      }
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
        async (toolCallId, operation, observers) => {
          if (!task.host?.pid || !isActive(task.snapshot.state))
            return { output: '当前任务无法执行工具', isError: true };
          return this.tools.execute(
            {
              sessionId: session.id,
              runId: task.snapshot.runId,
              hostEpoch: task.snapshot.hostEpoch,
              hostPid: task.host.pid,
              workspace: session.workspace,
              workingDirectory: task.outputDirectory,
              protectedRoots: [
                this.paths.sessions,
                this.paths.database,
                `${this.paths.database}-wal`,
                `${this.paths.database}-shm`,
                this.paths.logs,
              ],
              inputs: task.filePaths,
              published: this.artifacts.legacyPaths(session.id),
            },
            toolCallId,
            operation,
            observers,
          );
        },
        (toolCallId) => this.tools.cancelTool(task.snapshot.runId, toolCallId),
      );
      await task.host.request({
        type: 'runtime.start',
        config: {
          sessionId: session.id,
          runId: task.snapshot.runId,
          hostEpoch: task.snapshot.hostEpoch,
          file: session.sessionFile,
          workspace: session.workspace,
          piSessionId: session.piSessionId,
          model: task.model,
          thinkingLevel: task.thinkingLevel,
          apiKey,
          skillsDirectory: this.skillsDirectory,
          ...(this.testBaseUrl ? { testBaseUrl: this.testBaseUrl } : {}),
          protectedRoots: [
            this.paths.sessions,
            this.paths.database,
            `${this.paths.database}-wal`,
            `${this.paths.database}-shm`,
            join(this.paths.home, 'logs'),
          ],
        },
        input: task.input,
      });
      task.starting = false;
    } catch {
      this.fail(task, '无法启动任务，请检查模型凭证或重新打开会话。');
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
    // An interrupted prior process can leave an open output version to inventory.
    for (const version of this.artifacts.list(sessionId).versions)
      if (version.state === 'open') await this.artifacts.publish(version.id);
    await this.artifacts.settled();
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
