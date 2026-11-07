import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../../../src/main/storage/database';
import { RunLedger } from '../../../src/main/services/runtime/run-ledger';
import type { RuntimeSnapshot } from '../../../src/shared/runtime';
it('sessions.metadata-writes text snapshots do not write metadata; ACK and terminal transitions do', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys=ON');
    migrate(db);
    db.prepare(
      'INSERT INTO sessions (id,title,workspace,session_file,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    ).run('s', 'test', '/tmp/s', '/tmp/s.jsonl', 'draft', 'now', 'now');
    db.prepare("UPDATE sessions SET run_id='r',run_state='running' WHERE id='s'").run();
    const ledger = new RunLedger(db);
    ledger.accept('r', 's', {
      inputId: 'i',
      kind: 'prompt',
      text: 'test',
      paths: ['/tmp/input.csv'],
    });
    const initial: RuntimeSnapshot = {
      schemaVersion: 1,
      sessionId: 's',
      runId: 'r',
      seq: 1,
      state: 'running',
      messages: [],
      tools: [],
      inputs: [{ inputId: 'i', kind: 'prompt', state: 'pending' }],
      error: null,
    };
    const count = () => (db.prepare('SELECT total_changes() n').get() as { n: number }).n;
    const before = count();
    for (let seq = 2; seq < 100; seq++)
      ledger.transition(initial, {
        ...initial,
        seq,
        messages: [
          { id: 'm', role: 'assistant', blocks: [{ type: 'text', text: 'delta'.repeat(seq) }] },
        ],
      });
    expect(count()).toBe(before);
    const committed: RuntimeSnapshot = {
      ...initial,
      seq: 100,
      inputs: [{ inputId: 'i', kind: 'prompt', state: 'committed', entryId: 'entry' }],
    };
    ledger.transition(initial, committed);
    expect(count()).toBe(before + 1);
    expect(
      db.prepare('SELECT * FROM input_submissions WHERE pending_text IS NOT NULL').all(),
    ).toEqual([]);
    ledger.transition(committed, { ...committed, state: 'completed', seq: 101 });
    expect(db.prepare('SELECT run_state AS state FROM sessions').get()).toMatchObject({
      state: 'completed',
    });
    const beforeStale = count();
    ledger.transition(committed, {
      ...committed,
      runId: 'stale',
      state: 'failed',
      inputs: [{ inputId: 'i', kind: 'prompt', state: 'cancelled' }],
    });
    ledger.transition(committed, { ...committed, sessionId: 'other', state: 'failed' });
    expect(count()).toBe(beforeStale);
    expect(
      db.prepare('SELECT state,entry_id FROM input_submissions WHERE input_id=?').get('i'),
    ).toEqual({ state: 'committed', entry_id: 'entry' });
    expect(db.prepare('SELECT run_state FROM sessions').get()).toEqual({
      run_state: 'completed',
    });
    for (const kind of ['steer', 'followUp'] as const)
      ledger.accept('r', 's', {
        inputId: kind,
        kind,
        text: kind,
        paths: ['/tmp/' + kind + '.csv'],
      });
    expect(db.prepare('SELECT count(*) n FROM session_sources').get()).toEqual({ n: 3 });
    expect(
      ledger.withDrafts({ ...committed, state: 'completed' }).unsentInputs?.map((i) => i.kind),
    ).toEqual(['steer', 'followUp']);
  } finally {
    db.close();
  }
});
