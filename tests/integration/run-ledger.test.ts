import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { migrate } from '../../src/main/storage/database';
import { RunLedger } from '../../src/main/services/runtime/run-ledger';
import type { RuntimeSnapshot } from '../../src/shared/runtime';
it('R-WRITES text snapshots do not write metadata; ACK and terminal transitions do', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys=ON');
    migrate(db);
    db.prepare(
      'INSERT INTO sessions (id,title,workspace,session_file,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    ).run('s', 'test', '/tmp/s', '/tmp/s.jsonl', 'draft', 'now', 'now');
    db.prepare('INSERT INTO runs VALUES (?,?,?,?,?,?,?,NULL)').run(
      'r',
      's',
      'h',
      'running',
      'fixture',
      'model',
      'now',
    );
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
      hostEpoch: 'h',
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
    expect(count()).toBe(before + 2);
    expect(db.prepare('SELECT * FROM input_drafts').all()).toEqual([]);
    ledger.transition(committed, { ...committed, state: 'completed', seq: 101 });
    expect(db.prepare('SELECT state,ended_at FROM runs').get()).toMatchObject({
      state: 'completed',
      ended_at: expect.any(String),
    });
  } finally {
    db.close();
  }
});
