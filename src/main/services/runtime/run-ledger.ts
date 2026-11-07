import type Database from 'better-sqlite3';
import { AppError } from '../../../shared/errors';
import { isActive, type RunInput, type RuntimeSnapshot } from '../../../shared/runtime';
/** Durable input identity/ACKs. Content deltas belong to pi JSONL and renderer snapshots. */
export class RunLedger {
  constructor(private db: Database.Database) {}
  accept(runId: string, sessionId: string, input: RunInput) {
    if (this.db.prepare('SELECT id FROM run_inputs WHERE id=?').get(input.inputId))
      throw new AppError('DUPLICATE_INPUT', '该输入已提交，不会重复执行');
    this.db.transaction(() => {
      this.db
        .prepare('INSERT INTO run_inputs VALUES (?,?,?,?,NULL)')
        .run(input.inputId, runId, input.kind, 'pending');
      this.db
        .prepare('INSERT INTO input_drafts (input_id,text,paths) VALUES (?,?,?)')
        .run(input.inputId, input.text, JSON.stringify(input.paths ?? []));
      this.db
        .prepare('INSERT INTO submission_receipts VALUES (?,?,?)')
        .run(input.inputId, sessionId, JSON.stringify(input));
    })();
  }
  transition(previous: RuntimeSnapshot, next: RuntimeSnapshot) {
    const prior = new Map(previous.inputs.map((input) => [input.inputId, input]));
    this.db.transaction(() => {
      if (previous.state !== next.state)
        this.db
          .prepare('UPDATE runs SET state=?,ended_at=? WHERE id=?')
          .run(next.state, isActive(next.state) ? null : new Date().toISOString(), next.runId);
      for (const input of next.inputs) {
        const old = prior.get(input.inputId);
        if (old?.state === input.state && old.entryId === input.entryId) continue;
        const result = this.db
          .prepare('UPDATE run_inputs SET state=?,entry_id=? WHERE id=? AND run_id=?')
          .run(input.state, input.entryId ?? null, input.inputId, next.runId);
        if (result.changes && input.state === 'committed')
          this.db.prepare('DELETE FROM input_drafts WHERE input_id=?').run(input.inputId);
      }
    })();
  }
  withDrafts(snapshot: RuntimeSnapshot): RuntimeSnapshot {
    const drafts = this.db
      .prepare(
        `SELECT i.id AS inputId,i.kind,d.text,d.paths,i.run_id AS runId,i.state FROM input_drafts d JOIN run_inputs i ON i.id=d.input_id JOIN runs r ON r.id=i.run_id WHERE r.session_id=? ORDER BY i.rowid`,
      )
      .all(snapshot.sessionId) as (Omit<RunInput, 'paths'> & {
      paths: string;
      runId: string;
      state: string;
    })[];
    return {
      ...snapshot,
      queuedInputs: isActive(snapshot.state) ? (snapshot.queuedInputs ?? []) : [],
      unsentInputs: drafts
        .filter(
          (d) => d.runId !== snapshot.runId || d.state !== 'pending' || !isActive(snapshot.state),
        )
        .map(({ inputId, kind, text, paths }) => ({
          inputId,
          kind,
          text,
          paths: JSON.parse(paths) as string[],
        })),
    };
  }
}
