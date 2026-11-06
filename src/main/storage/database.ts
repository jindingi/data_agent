import Database from 'better-sqlite3';

export interface Migration { version: number; sql: string }
export const migrations: Migration[] = [{ version: 1, sql: `
  CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
` }, { version: 2, sql: `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace TEXT NOT NULL UNIQUE,
    session_file TEXT NOT NULL UNIQUE, pi_session_id TEXT, state TEXT NOT NULL,
    error TEXT, history_known INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE file_refs (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    path TEXT NOT NULL, name TEXT NOT NULL, size INTEGER NOT NULL CHECK(size >= 0), added_at TEXT NOT NULL,
    UNIQUE(session_id, path)
  );
  CREATE INDEX sessions_updated ON sessions(archived,updated_at DESC);
` }, { version: 3, sql: `
  CREATE TABLE runs (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), host_epoch TEXT NOT NULL,
    state TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, created_at TEXT NOT NULL, ended_at TEXT
  );
  CREATE TABLE run_inputs (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), kind TEXT NOT NULL, state TEXT NOT NULL, entry_id TEXT
  );
` }, { version: 4, sql: `
  CREATE TABLE interactions (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL REFERENCES runs(id),
    host_epoch TEXT NOT NULL, tool_call_id TEXT NOT NULL, kind TEXT NOT NULL, details TEXT NOT NULL,
    state TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT
  );
` }, { version: 5, sql: `
  CREATE TABLE output_versions (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL REFERENCES runs(id),
    directory TEXT NOT NULL UNIQUE, state TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL
  );
  CREATE TABLE artifacts (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL REFERENCES runs(id),
    version_id TEXT NOT NULL REFERENCES output_versions(id), path TEXT NOT NULL UNIQUE, relative_path TEXT NOT NULL,
    kind TEXT NOT NULL, state TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, error TEXT, created_at TEXT NOT NULL,
    UNIQUE(version_id,relative_path)
  );
  CREATE INDEX artifacts_session ON artifacts(session_id,created_at);
` }];
export function migrate(db: Database.Database, pending = migrations) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const migration of pending) {
    if (db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(migration.version)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(migration.version, new Date().toISOString());
    })();
  }
}
export function openDatabase(file: string) {
  const db = new Database(file);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    migrate(db);
    db.prepare('INSERT INTO app_metadata VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('last_started_at', new Date().toISOString());
    return db;
  } catch (error) { db.close(); throw error; }
}
