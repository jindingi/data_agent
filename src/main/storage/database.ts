import Database from 'better-sqlite3';

export interface Migration { version: number; sql: string }
export const migrations: Migration[] = [{ version: 1, sql: `
  CREATE TABLE app_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
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
