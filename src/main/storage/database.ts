import { simplifyStorage } from './simplify';
import { mkdirSync, chmodSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { submissionDigest } from '../../node/submission-digest';
import { inputSchema } from '../../shared/runtime';
import Database from 'better-sqlite3';

export interface Migration {
  version: number;
  sql: string;
  after?: (db: Database.Database) => void;
}
export const migrations: Migration[] = [
  {
    version: 1,
    sql: `
  CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`,
  },
  {
    version: 2,
    sql: `
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
`,
  },
  {
    version: 3,
    sql: `
  CREATE TABLE runs (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), host_epoch TEXT NOT NULL,
    state TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, created_at TEXT NOT NULL, ended_at TEXT
  );
  CREATE TABLE run_inputs (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), kind TEXT NOT NULL, state TEXT NOT NULL, entry_id TEXT
  );
`,
  },
  {
    version: 4,
    sql: `
  CREATE TABLE interactions (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT NOT NULL REFERENCES runs(id),
    host_epoch TEXT NOT NULL, tool_call_id TEXT NOT NULL, kind TEXT NOT NULL, details TEXT NOT NULL,
    state TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT
  );
`,
  },
  {
    version: 5,
    sql: `
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
`,
  },
  {
    version: 6,
    sql: `
  CREATE TABLE input_drafts (
    input_id TEXT PRIMARY KEY REFERENCES run_inputs(id) ON DELETE CASCADE,
    text TEXT NOT NULL
  );
`,
  },
  {
    version: 7,
    sql: `
  CREATE TABLE tool_logs (
    id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), tool_call_id TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE, peak_rss INTEGER NOT NULL DEFAULT 0, reason TEXT, truncated INTEGER NOT NULL DEFAULT 0,
    UNIQUE(run_id,tool_call_id)
  );
  CREATE TABLE run_files (
    run_id TEXT NOT NULL REFERENCES runs(id), path TEXT NOT NULL, size INTEGER NOT NULL,
    PRIMARY KEY(run_id,path)
  );
  CREATE TABLE deletion_jobs (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    delete_artifacts INTEGER NOT NULL, prepared INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE deletion_files (
    session_id TEXT NOT NULL REFERENCES deletion_jobs(session_id) ON DELETE CASCADE,
    path TEXT NOT NULL, kind TEXT NOT NULL, sha256 TEXT,
    state TEXT NOT NULL DEFAULT 'pending', error TEXT,
    PRIMARY KEY(session_id,path)
  );
`,
  },
  {
    version: 8,
    sql: `
    ALTER TABLE input_drafts ADD COLUMN paths TEXT NOT NULL DEFAULT '[]';
    CREATE TABLE submission_receipts (
      input_id TEXT PRIMARY KEY REFERENCES run_inputs(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      payload TEXT NOT NULL
    );
    CREATE TABLE conversation_intents (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE
    );
  `,
  },
  {
    version: 9,
    sql: 'ALTER TABLE submission_receipts RENAME COLUMN payload TO digest;',
    after: (db) => {
      for (const row of db.prepare('SELECT input_id,digest FROM submission_receipts').all() as {
        input_id: string;
        digest: string;
      }[]) {
        const input = inputSchema.parse(JSON.parse(row.digest));
        db.prepare('UPDATE submission_receipts SET digest=? WHERE input_id=?').run(
          submissionDigest(input),
          row.input_id,
        );
      }
    },
  },
  {
    version: 10,
    sql: `
      CREATE TABLE agent_config_revisions (
        revision INTEGER PRIMARY KEY AUTOINCREMENT, snapshot TEXT NOT NULL
      );
      CREATE TABLE session_agent_configs (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        snapshot TEXT NOT NULL
      );
    `,
  },
  { version: 11, sql: '', after: simplifyStorage },
  {
    version: 12,
    sql: `
      ALTER TABLE sessions RENAME COLUMN execution_id TO run_id;
      ALTER TABLE sessions RENAME COLUMN execution_state TO run_state;
      ALTER TABLE sessions RENAME COLUMN execution_error TO run_error;
      ALTER TABLE sessions DROP COLUMN execution_epoch;
      ALTER TABLE sessions DROP COLUMN execution_started_at;
      ALTER TABLE sessions DROP COLUMN execution_ended_at;
      ALTER TABLE sessions DROP COLUMN execution_provider;
      ALTER TABLE sessions DROP COLUMN execution_model;
      ALTER TABLE input_submissions RENAME COLUMN execution_id TO run_id;
    `,
  },
];
export function migrate(db: Database.Database, pending = migrations) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
  for (const migration of pending) {
    if (
      db.prepare('SELECT version FROM schema_migrations WHERE version = ?').get(migration.version)
    )
      continue;
    db.transaction(() => {
      db.exec(migration.sql);
      migration.after?.(db);
      db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(
        migration.version,
        new Date().toISOString(),
      );
    })();
  }
}
export function openDatabase(file: string) {
  const db = new Database(file);
  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    const hasMigrations = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
      .get();
    const version = hasMigrations
      ? ((
          db.prepare('SELECT MAX(version) version FROM schema_migrations').get() as {
            version: number;
          }
        ).version ?? 0)
      : 0;
    if (version > migrations.at(-1)!.version)
      throw new Error('数据库版本高于此应用支持范围，请升级应用');
    if (version > 0 && version < migrations.at(-1)!.version && file !== ':memory:') {
      const directory = join(dirname(file), 'backups');
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (
        lstatSync(directory).isSymbolicLink() ||
        realpathSync(directory) !== join(realpathSync(dirname(file)), 'backups')
      )
        throw new Error('数据库备份目录已重定向，升级已停止');
      const backup = join(directory, `state-v${version}-${randomUUID()}.sqlite`);
      db.prepare('VACUUM INTO ?').run(backup);
      chmodSync(backup, 0o600);
    }
    migrate(db);
    db.prepare(
      'INSERT INTO app_metadata VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    ).run('last_started_at', new Date().toISOString());
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
