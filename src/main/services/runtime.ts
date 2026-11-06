import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { HostInput } from '../../shared/contracts/host';
import type { HostStatus } from '../../shared/contracts/ipc';
import type { CredentialService } from './credentials';
import type { SessionService } from './sessions';
import type { AppPaths } from '../../node/app-paths';
import { AppError } from '../../shared/errors';
import { isActive, type MessageView, type ModelChoice, type RunInput, type RuntimeSnapshot } from '../../shared/runtime';

export interface RuntimeHost { request(input: HostInput): Promise<unknown>; stop(): void }
type HostFactory = (status: (status: HostStatus) => void, snapshot: (snapshot: RuntimeSnapshot) => void) => RuntimeHost;
interface Task { snapshot: RuntimeSnapshot; input: RunInput; model: ModelChoice; apiKey?: string; host?: RuntimeHost; starting: boolean }
/** Global admission only; pi owns each conversation's steer/follow-up queue. */
export class RuntimeService {
  private tasks = new Map<string, Task>();
  private queue: Task[] = [];
  private closing = false;
  constructor(private db: Database.Database, private sessions: SessionService, private credentials: CredentialService, private paths: AppPaths, private createHost: HostFactory, private reader: { readHistory(file: string, workspace: string, piSessionId: string): Promise<unknown> }, private publish: (snapshot: RuntimeSnapshot) => void, private changed: () => void) {
    db.prepare("UPDATE runs SET state='failed',ended_at=? WHERE state IN ('queued','starting','running')").run(new Date().toISOString());
    db.prepare("UPDATE run_inputs SET state='unknown' WHERE state='pending'").run();
  }
  snapshot(sessionId: string) { this.sessions.get(sessionId); return this.tasks.get(sessionId)?.snapshot ?? null; }
  private update(task: Task, snapshot: RuntimeSnapshot) {
    if (this.closing || !isActive(task.snapshot.state) || this.tasks.get(snapshot.sessionId) !== task || task.snapshot.hostEpoch !== snapshot.hostEpoch || snapshot.seq <= task.snapshot.seq) return;
    task.snapshot = snapshot;
    this.db.prepare('UPDATE runs SET state=?,ended_at=? WHERE id=?').run(snapshot.state, isActive(snapshot.state) ? null : new Date().toISOString(), snapshot.runId);
    for (const input of snapshot.inputs) this.db.prepare('UPDATE run_inputs SET state=?,entry_id=? WHERE id=? AND run_id=?').run(input.state, input.entryId ?? null, input.inputId, snapshot.runId);
    this.publish(snapshot);
    if (!isActive(snapshot.state)) {
      task.apiKey = undefined;
      const host = task.host; task.host = undefined; task.starting = false; host?.stop();
      this.sessions.reconcile(snapshot.sessionId); this.changed(); this.pump();
    }
  }
  async submit(sessionId: string, input: RunInput) {
    if (this.closing) throw new AppError('QUITTING', '应用正在退出');
    const current = this.tasks.get(sessionId);
    if (current && isActive(current.snapshot.state)) {
      if (input.kind === 'prompt') throw new AppError('ALREADY_RUNNING', '会话已有任务，请使用插话或后续提问');
      if (!current.host || current.snapshot.state !== 'running') throw new AppError('NOT_RUNNING', '任务尚在等待启动，请稍后插话');
      this.insertInput(current, input);
      try { await current.host.request({ type: 'runtime.input', input }); } catch (error) { this.db.prepare("UPDATE run_inputs SET state='unknown' WHERE id=?").run(input.inputId); throw error; }
      return current.snapshot;
    }
    if (input.kind !== 'prompt') throw new AppError('NOT_RUNNING', '本次任务已结束，请作为新提问发送');
    // Preflight before allocating a run or a concurrency permit.
    const model = this.credentials.selected(); this.credentials.validate(model); const apiKey = this.credentials.key(model.provider);
    this.sessions.reconcile(sessionId);
    const session = this.sessions.get(sessionId);
    if (session.archived || !['draft', 'persisted'].includes(session.state)) throw new AppError('SESSION_UNAVAILABLE', session.error || '请先恢复会话后再提问');
    const files = this.sessions.files(sessionId);
    if (files.some(file => file.missing)) throw new AppError('INPUT_MISSING', '部分原文件不可用，请移除缺失文件或重新选择');
    let messages: MessageView[] = [];
    if (session.piSessionId && session.state === 'persisted') messages = (await this.reader.readHistory(session.sessionFile, session.workspace, session.piSessionId) as { messages: MessageView[] }).messages;
    // A read RPC yields: recheck admission before creating another task for the same session.
    if (isActive(this.tasks.get(sessionId)?.snapshot.state ?? 'completed')) throw new AppError('ALREADY_RUNNING', '该会话已有任务');
    const task: Task = { input, model, apiKey, starting: false, snapshot: { schemaVersion: 1, sessionId, runId: randomUUID(), hostEpoch: randomUUID(), seq: 0, state: 'queued', messages, tools: [], inputs: [{ inputId: input.inputId, kind: input.kind, state: 'pending' }], queuedInputs: [input], error: null } };
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO runs VALUES (?,?,?,?,?,?,?,NULL)').run(task.snapshot.runId, sessionId, task.snapshot.hostEpoch, 'queued', model.provider, model.model, new Date().toISOString());
      this.insertInput(task, input);
      this.db.prepare('UPDATE sessions SET updated_at=? WHERE id=?').run(new Date().toISOString(), sessionId);
    })();
    this.tasks.set(sessionId, task); this.queue.push(task); this.publish(task.snapshot); this.changed(); this.pump();
    return task.snapshot;
  }
  private insertInput(task: Task, input: RunInput) {
    if (this.db.prepare('SELECT id FROM run_inputs WHERE id=?').get(input.inputId)) throw new AppError('DUPLICATE_INPUT', '该输入已提交，不会重复执行');
    this.db.prepare('INSERT INTO run_inputs VALUES (?,?,?,?,NULL)').run(input.inputId, task.snapshot.runId, input.kind, 'pending');
  }
  private pump() {
    if (this.closing) return;
    while ([...this.tasks.values()].filter(task => task.starting || task.host).length < 2 && this.queue.length) {
      const task = this.queue.shift()!;
      if (task.snapshot.state !== 'queued') continue;
      task.starting = true;
      void this.start(task);
    }
  }
  private async start(task: Task) {
    const session = this.sessions.get(task.snapshot.sessionId);
    // Main's pre-start seq stays 0; the Host becomes the sole positive sequence producer.
    task.snapshot = { ...task.snapshot, state: 'starting' }; this.publish(task.snapshot);
    try {
      const apiKey = task.apiKey;
      if (!apiKey) throw new AppError('MISSING_KEY', '运行凭证已失效');
      task.host = this.createHost(status => {
        if (status === 'exited' && isActive(task.snapshot.state) && !this.closing) this.fail(task, 'Agent 进程已退出，本轮已停止。未确认的输入不会自动重发。');
      }, snapshot => this.update(task, snapshot));
      await task.host.request({ type: 'runtime.start', config: { sessionId: session.id, runId: task.snapshot.runId, hostEpoch: task.snapshot.hostEpoch, file: session.sessionFile, workspace: session.workspace, piSessionId: session.piSessionId, model: task.model, apiKey,
        protectedRoots: [this.paths.sessions, this.paths.database, `${this.paths.database}-wal`, `${this.paths.database}-shm`, join(this.paths.home, 'logs')], filePaths: this.sessions.files(session.id).map(file => file.path) }, input: task.input });
      task.starting = false;
    } catch { this.fail(task, '无法启动任务，请检查模型凭证或重新打开会话。'); }
    finally { task.apiKey = undefined; }
  }
  private fail(task: Task, error: string) {
    if (!isActive(task.snapshot.state)) return;
    this.update(task, { ...task.snapshot, seq: task.snapshot.seq + 1, state: 'failed', error, inputs: task.snapshot.inputs.map(input => input.state === 'pending' ? { ...input, state: 'unknown' } : input) });
  }
  async cancel(sessionId: string) {
    const task = this.tasks.get(sessionId);
    if (!task || !isActive(task.snapshot.state)) return;
    if (task.snapshot.state === 'queued' || task.snapshot.state === 'starting') {
      this.update(task, { ...task.snapshot, seq: task.snapshot.seq + 1, state: 'cancelled', inputs: task.snapshot.inputs.map(input => ({ ...input, state: 'cancelled' })) }); return;
    }
    try { await task.host?.request({ type: 'runtime.cancel' }); } catch { this.fail(task, '停止时 Agent 未响应，进程已结束。'); }
  }
  stop() { this.closing = true; for (const task of this.tasks.values()) task.host?.stop(); }
}
