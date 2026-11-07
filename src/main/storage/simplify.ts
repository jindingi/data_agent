import type Database from 'better-sqlite3';
/** Runs only inside migration 11's transaction; never touches session or workspace files. */
export function simplifyStorage(db: Database.Database) {
  db.exec(`
    ALTER TABLE sessions ADD COLUMN creation_pending INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE sessions ADD COLUMN execution_id TEXT;
    ALTER TABLE sessions ADD COLUMN execution_epoch TEXT;
    ALTER TABLE sessions ADD COLUMN execution_state TEXT;
    ALTER TABLE sessions ADD COLUMN execution_started_at TEXT;
    ALTER TABLE sessions ADD COLUMN execution_ended_at TEXT;
    ALTER TABLE sessions ADD COLUMN execution_error TEXT;
    ALTER TABLE sessions ADD COLUMN execution_provider TEXT;
    ALTER TABLE sessions ADD COLUMN execution_model TEXT;
    ALTER TABLE sessions ADD COLUMN agent_config_revision INTEGER REFERENCES agent_config_revisions(revision);
    ALTER TABLE sessions ADD COLUMN agent_config_override TEXT;
    UPDATE sessions SET creation_pending=1 WHERE id IN (SELECT session_id FROM conversation_intents);
    UPDATE sessions SET (execution_id,execution_epoch,execution_state,execution_started_at,execution_ended_at,execution_provider,execution_model)=
      (SELECT id,host_epoch,state,created_at,ended_at,provider,model FROM runs WHERE session_id=sessions.id ORDER BY created_at DESC,rowid DESC LIMIT 1);
    UPDATE sessions SET execution_state='interrupted',execution_ended_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE execution_state IN ('queued','starting','running','waiting_approval','waiting_input');
    CREATE TABLE input_submissions (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      input_id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      execution_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      entry_id TEXT,
      digest TEXT,
      pending_text TEXT,
      pending_paths TEXT
    );
    CREATE INDEX input_submissions_session ON input_submissions(session_id,sequence);
    INSERT INTO input_submissions (input_id,session_id,execution_id,kind,state,entry_id,digest,pending_text,pending_paths)
      SELECT i.id,r.session_id,i.run_id,i.kind,CASE WHEN i.state='pending' THEN 'unknown' ELSE i.state END,i.entry_id,s.digest,
        CASE WHEN i.state='committed' THEN NULL ELSE d.text END,
        CASE WHEN i.state='committed' THEN NULL ELSE d.paths END
      FROM run_inputs i JOIN runs r ON r.id=i.run_id LEFT JOIN submission_receipts s ON s.input_id=i.id
      LEFT JOIN input_drafts d ON d.input_id=i.id ORDER BY i.rowid;
    CREATE TABLE session_sources (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      origin TEXT NOT NULL,
      PRIMARY KEY(session_id,path)
    );
    INSERT OR IGNORE INTO session_sources SELECT session_id,path,'legacy_selected' FROM file_refs;
    INSERT OR REPLACE INTO session_sources SELECT r.session_id,f.path,'accepted' FROM run_files f JOIN runs r ON r.id=f.run_id;
  `);
  const bindings = db.prepare('SELECT session_id,snapshot FROM session_agent_configs').all() as {
    session_id: string;
    snapshot: string;
  }[];
  const revisions = new Map(
    (
      db.prepare('SELECT revision,snapshot FROM agent_config_revisions').all() as {
        revision: number;
        snapshot: string;
      }[]
    ).map((row) => [row.revision, row.snapshot]),
  );
  for (const row of bindings) {
    let revision: number | null = null;
    try {
      const value = JSON.parse(row.snapshot);
      const original = revisions.get(value.revision);
      if (original && JSON.stringify(JSON.parse(original)) === JSON.stringify(value))
        revision = value.revision;
    } catch {
      /* Preserve unrecognized bindings as unavailable rather than substituting defaults. */
    }
    db.prepare(
      'UPDATE sessions SET agent_config_revision=?,agent_config_override=? WHERE id=?',
    ).run(revision, revision === null ? row.snapshot : null, row.session_id);
  }
  const before = (db.prepare('SELECT count(*) n FROM run_inputs').get() as { n: number }).n;
  if ((db.prepare('SELECT count(*) n FROM input_submissions').get() as { n: number }).n !== before)
    throw new Error('输入记录迁移不完整');
  db.exec(`
    DROP TABLE deletion_files; DROP TABLE deletion_jobs;
    DROP TABLE artifacts; DROP TABLE output_versions; DROP TABLE tool_logs;
    DROP TABLE interactions; DROP TABLE run_files; DROP TABLE file_refs;
    DROP TABLE submission_receipts; DROP TABLE input_drafts; DROP TABLE run_inputs;
    DROP TABLE conversation_intents; DROP TABLE session_agent_configs; DROP TABLE runs;
  `);
  if ((db.pragma('foreign_key_check') as unknown[]).length) throw new Error('迁移后外键检查失败');
}
