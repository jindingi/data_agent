import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { migrations, migrate, openDatabase } from '../../../src/main/storage/database';

it('sessions.storage-migration upgrades populated WAL storage atomically to six tables without touching files', () => {
  const root = mkdtempSync(join(tmpdir(), 'storage-upgrade-'));
  const file = join(root, 'state.sqlite');
  const db = new Database(file);
  const session = randomUUID(),
    second = randomUUID(),
    firstRun = randomUUID(),
    lastRun = randomUUID();
  const pending = randomUUID(),
    committed = randomUUID(),
    followup = randomUUID();
  const workspace = join(root, 'workspace'),
    history = join(root, 'history.jsonl');
  mkdirSync(workspace);
  const report = join(workspace, 'report.md');
  writeFileSync(report, 'must survive a prepared legacy deletion');
  writeFileSync(history, 'native history sentinel — migration never opens this');
  const bytes = [readFileSync(report), readFileSync(history)];
  try {
    db.pragma('journal_mode=WAL');
    db.pragma('wal_autocheckpoint=0');
    db.pragma('foreign_keys=ON');
    migrate(
      db,
      migrations.filter((m) => m.version <= 10),
    );
    for (const [id, path] of [
      [session, workspace],
      [second, join(root, 'other')],
    ]) {
      db.prepare(
        'INSERT INTO sessions(id,title,workspace,session_file,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
      ).run(id, 'fixture', path, join(root, id + '.jsonl'), 'deleting', '2026-01-01', '2026-01-01');
    }
    const original = JSON.stringify({ revision: 1, fingerprint: 'fixed', skill: 'unchanged' });
    const special = JSON.stringify({ revision: 1, fingerprint: 'historical', skill: 'historical' });
    db.prepare('INSERT INTO agent_config_revisions VALUES (?,?)').run(1, original);
    db.prepare('INSERT INTO session_agent_configs VALUES (?,?)').run(session, original);
    db.prepare('INSERT INTO session_agent_configs VALUES (?,?)').run(second, special);
    for (const [id, state] of [
      [firstRun, 'completed'],
      [lastRun, 'running'],
    ])
      db.prepare('INSERT INTO runs VALUES (?,?,?,?,?,?,?,NULL)').run(
        id,
        session,
        'epoch-' + id,
        state,
        'deepseek',
        'deepseek-flash',
        '2026-01-02',
      );
    for (const [id, run, kind, state] of [
      [pending, firstRun, 'steer', 'unknown'],
      [committed, firstRun, 'prompt', 'committed'],
      [followup, lastRun, 'followUp', 'pending'],
    ]) {
      db.prepare('INSERT INTO run_inputs VALUES (?,?,?,?,?)').run(
        id,
        run,
        kind,
        state,
        state === 'committed' ? 'native-entry' : null,
      );
      db.prepare('INSERT INTO input_drafts VALUES (?,?,?)').run(
        id,
        'body-' + id,
        JSON.stringify(['/input/' + id]),
      );
      db.prepare('INSERT INTO submission_receipts VALUES (?,?,?)').run(id, session, 'digest-' + id);
    }
    db.prepare('INSERT INTO conversation_intents VALUES (?)').run(second);
    db.prepare('INSERT INTO file_refs VALUES (?,?,?,?,?,?)').run(
      randomUUID(),
      session,
      '/selected.csv',
      'selected.csv',
      1,
      'date',
    );
    db.prepare('INSERT INTO run_files VALUES (?,?,?)').run(lastRun, '/accepted.csv', 2);
    db.prepare('INSERT INTO deletion_jobs VALUES (?,1,1)').run(session);
    db.prepare("INSERT INTO deletion_files VALUES (?,?,'artifact','old-hash','pending',NULL)").run(
      session,
      report,
    );
    const version = randomUUID();
    db.prepare("INSERT INTO output_versions VALUES (?,?,?,?,'published',NULL,'date')").run(
      version,
      session,
      firstRun,
      workspace,
    );
    db.prepare(
      "INSERT INTO artifacts VALUES (?,?,?,?,?,?,'markdown','ready',4,'old-hash',NULL,'date')",
    ).run(randomUUID(), session, firstRun, version, report, 'report.md');
    db.prepare('INSERT INTO tool_logs VALUES (?,?,?,?,0,NULL,0)').run(
      randomUUID(),
      firstRun,
      'old-tool',
      join(root, 'old.log'),
    );
    // Failure after all DDL still rolls the whole migration back.
    const migration = migrations.find((item) => item.version === 11)!;
    expect(() =>
      migrate(db, [
        {
          ...migration,
          after(database) {
            migration.after!(database);
            throw new Error('injected');
          },
        },
      ]),
    ).toThrow('injected');
    expect(db.prepare('SELECT count(*) n FROM run_inputs').get()).toEqual({ n: 3 });
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='input_submissions'").get(),
    ).toBeUndefined();
    // Keep old connection open so the consistent backup must include committed WAL.
    const upgraded = openDatabase(file);
    try {
      expect(
        upgraded
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
          )
          .all(),
      ).toEqual(
        [
          'agent_config_revisions',
          'app_metadata',
          'input_submissions',
          'schema_migrations',
          'session_sources',
          'sessions',
        ].map((name) => ({ name })),
      );
      const snapshot = upgraded
        .prepare(
          'SELECT run_id,run_state,agent_config_revision,agent_config_override FROM sessions WHERE id=?',
        )
        .get(session);
      expect(snapshot).toEqual({
        run_id: lastRun,
        run_state: 'interrupted',
        agent_config_revision: 1,
        agent_config_override: null,
      });
      expect(
        upgraded
          .prepare('SELECT creation_pending,agent_config_override FROM sessions WHERE id=?')
          .get(second),
      ).toEqual({ creation_pending: 1, agent_config_override: special });
      const inputs = upgraded
        .prepare(
          'SELECT input_id,state,pending_text,pending_paths,digest FROM input_submissions ORDER BY sequence',
        )
        .all();
      expect(inputs).toEqual([
        {
          input_id: pending,
          state: 'unknown',
          pending_text: 'body-' + pending,
          pending_paths: JSON.stringify(['/input/' + pending]),
          digest: 'digest-' + pending,
        },
        {
          input_id: committed,
          state: 'committed',
          pending_text: null,
          pending_paths: null,
          digest: 'digest-' + committed,
        },
        {
          input_id: followup,
          state: 'unknown',
          pending_text: 'body-' + followup,
          pending_paths: JSON.stringify(['/input/' + followup]),
          digest: 'digest-' + followup,
        },
      ]);
      expect(
        upgraded.prepare('SELECT path,origin FROM session_sources ORDER BY path').all(),
      ).toEqual([
        { path: '/accepted.csv', origin: 'accepted' },
        { path: '/selected.csv', origin: 'legacy_selected' },
      ]);
      expect(upgraded.pragma('foreign_key_check')).toEqual([]);
      migrate(upgraded);
      expect(upgraded.prepare('SELECT count(*) n FROM input_submissions').get()).toEqual({ n: 3 });
      const backups = readdirSync(join(root, 'backups'));
      expect(backups).toHaveLength(1);
      const backup = new Database(join(root, 'backups', backups[0]), { readonly: true });
      try {
        expect(backup.prepare('SELECT count(*) n FROM run_inputs').get()).toEqual({ n: 3 });
        expect(backup.prepare('SELECT max(version) n FROM schema_migrations').get()).toEqual({
          n: 10,
        });
      } finally {
        backup.close();
      }
      upgraded.prepare("INSERT INTO schema_migrations VALUES (999,'future')").run();
      expect(() => openDatabase(file)).toThrow('数据库版本高于');
    } finally {
      upgraded.close();
    }
    expect(readFileSync(report)).toEqual(bytes[0]);
    expect(readFileSync(history)).toEqual(bytes[1]);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it('sessions.run-migration preserves schema 11 identities, errors and inputs while dropping unused execution metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'run-upgrade-'));
  const file = join(root, 'state.sqlite');
  const legacy = new Database(file);
  try {
    legacy.pragma('journal_mode=WAL');
    legacy.pragma('foreign_keys=ON');
    migrate(
      legacy,
      migrations.filter((item) => item.version <= 11),
    );
    legacy
      .prepare(
        `INSERT INTO sessions(id,title,workspace,session_file,state,created_at,updated_at,
      execution_id,execution_epoch,execution_state,execution_error,execution_provider,execution_model,execution_started_at,execution_ended_at)
      VALUES ('s','kept',? ,?,'persisted','created','updated','r','epoch','failed','kept error','deepseek','deepseek-flash','start','end')`,
      )
      .run(join(root, 'workspace'), join(root, 'history.jsonl'));
    legacy
      .prepare(
        `INSERT INTO input_submissions(input_id,session_id,execution_id,kind,state,digest,pending_text,pending_paths)
      VALUES ('i','s','r','followUp','unknown','digest','pending','["/source.csv"]')`,
      )
      .run();
    const originalInputs = legacy.prepare('SELECT * FROM input_submissions').all() as Record<
      string,
      unknown
    >[];
    const migration = migrations.find((item) => item.version === 12)!;
    expect(() =>
      migrate(legacy, [
        {
          ...migration,
          after() {
            throw new Error('injected after DDL');
          },
        },
      ]),
    ).toThrow('injected after DDL');
    expect(legacy.prepare('SELECT execution_id,execution_error FROM sessions').get()).toEqual({
      execution_id: 'r',
      execution_error: 'kept error',
    });
    expect(legacy.prepare('SELECT * FROM input_submissions').all()).toEqual(originalInputs);
    const upgraded = openDatabase(file);
    try {
      const columns = (upgraded.pragma('table_info(sessions)') as { name: string }[]).map(
        (item) => item.name,
      );
      expect(columns.filter((name) => name.startsWith('execution_'))).toEqual([]);
      expect(columns.filter((name) => name.startsWith('run_')).sort()).toEqual([
        'run_error',
        'run_id',
        'run_state',
      ]);
      expect(
        upgraded
          .prepare('SELECT run_id,run_state,run_error,title,created_at,updated_at FROM sessions')
          .get(),
      ).toEqual({
        run_id: 'r',
        run_state: 'failed',
        run_error: 'kept error',
        title: 'kept',
        created_at: 'created',
        updated_at: 'updated',
      });
      expect(upgraded.prepare('SELECT * FROM input_submissions').all()).toEqual(
        originalInputs.map(({ execution_id, ...rest }) => ({ ...rest, run_id: execution_id })),
      );
      expect(upgraded.pragma('foreign_key_check')).toEqual([]);
      migrate(upgraded);
      expect(upgraded.prepare('SELECT count(*) n FROM input_submissions').get()).toEqual({ n: 1 });
      const backups = readdirSync(join(root, 'backups'));
      expect(backups).toHaveLength(1);
      const backup = new Database(join(root, 'backups', backups[0]), { readonly: true });
      try {
        expect(backup.prepare('SELECT execution_id,execution_error FROM sessions').get()).toEqual({
          execution_id: 'r',
          execution_error: 'kept error',
        });
        expect(backup.prepare('SELECT max(version) n FROM schema_migrations').get()).toEqual({
          n: 11,
        });
      } finally {
        backup.close();
      }
    } finally {
      upgraded.close();
    }
    const reopened = openDatabase(file);
    reopened.close();
    expect(readdirSync(join(root, 'backups'))).toHaveLength(1);
  } finally {
    legacy.close();
    rmSync(root, { recursive: true, force: true });
  }
});
