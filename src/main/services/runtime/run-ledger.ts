import { submissionDigest } from '../../../node/submission-digest';
import type Database from 'better-sqlite3';
import { AppError } from '../../../shared/errors';
import { isActive, type RunInput, type RuntimeSnapshot } from '../../../shared/runtime';
/** Input delivery metadata only; committed conversation content belongs to pi JSONL. */
export class RunLedger {
  constructor(private db: Database.Database) {}
  accept(runId: string, sessionId: string, input: RunInput, sources = input.paths ?? []) {
    if (
      this.db.prepare('SELECT input_id FROM input_submissions WHERE input_id=?').get(input.inputId)
    )
      throw new AppError('DUPLICATE_INPUT', '该输入已提交，不会重复执行');
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO input_submissions(input_id,session_id,execution_id,kind,state,digest,pending_text,pending_paths)
        VALUES (?,?,?,?,'pending',?,?,?)`,
        )
        .run(
          input.inputId,
          sessionId,
          runId,
          input.kind,
          submissionDigest(input),
          input.text,
          JSON.stringify(input.paths ?? []),
        );
      for (const path of sources)
        this.db
          .prepare("INSERT OR IGNORE INTO session_sources VALUES (?,?,'accepted')")
          .run(sessionId, path);
    })();
  }
  transition(previous: RuntimeSnapshot, next: RuntimeSnapshot) {
    const prior = new Map(previous.inputs.map((input) => [input.inputId, input]));
    this.db.transaction(() => {
      if (
        !this.db
          .prepare('SELECT id FROM sessions WHERE id=? AND execution_id=? AND execution_epoch=?')
          .get(next.sessionId, next.runId, next.hostEpoch)
      )
        return;
      if (previous.state !== next.state || previous.error !== next.error)
        this.db
          .prepare(
            'UPDATE sessions SET execution_state=?,execution_ended_at=?,execution_error=? WHERE id=? AND execution_id=? AND execution_epoch=?',
          )
          .run(
            next.state,
            isActive(next.state) ? null : new Date().toISOString(),
            next.error,
            next.sessionId,
            next.runId,
            next.hostEpoch,
          );
      for (const input of next.inputs) {
        const old = prior.get(input.inputId);
        if (old?.state === input.state && old.entryId === input.entryId) continue;
        this.db
          .prepare(
            `UPDATE input_submissions SET state=?,entry_id=?,pending_text=CASE WHEN ?='committed' THEN NULL ELSE pending_text END,
          pending_paths=CASE WHEN ?='committed' THEN NULL ELSE pending_paths END WHERE input_id=? AND execution_id=? AND session_id=?`,
          )
          .run(
            input.state,
            input.entryId ?? null,
            input.state,
            input.state,
            input.inputId,
            next.runId,
            next.sessionId,
          );
      }
    })();
  }
  withDrafts(snapshot: RuntimeSnapshot): RuntimeSnapshot {
    const drafts = this.db
      .prepare(
        `SELECT input_id AS inputId,kind,pending_text AS text,pending_paths AS paths,execution_id AS runId,state
      FROM input_submissions WHERE session_id=? AND pending_text IS NOT NULL ORDER BY sequence`,
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
          paths: JSON.parse(paths ?? '[]'),
        })),
    };
  }
}
