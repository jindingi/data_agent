import { describe, expect, it } from 'vitest';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { projectTurnUsage, TurnUsageLedger } from '../../../src/agent/turn-usage';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHistory } from '../../../src/agent/history';

const first = randomUUID(),
  second = randomUUID();
let sequence = 0;
function entry(data: object): SessionEntry {
  return {
    id: `entry-${sequence++}`,
    parentId: null,
    timestamp: new Date().toISOString(),
    ...data,
  } as SessionEntry;
}
const boundary = (inputId: string, state: string) =>
  entry({
    type: 'custom',
    customType: 'data_agent.usage_boundary',
    data: { version: 1, inputId, state },
  });
const user = (id: string) =>
  entry({
    type: 'message',
    message: { role: 'user', content: `[data-agent-input:${id}]\nQuestion` },
  });
const usage = (input = 10, output = 20, cacheRead = 30, cacheWrite = 0, reasoning = 5) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
  reasoning,
  totalTokens: input + output + cacheRead + cacheWrite,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
const answer = (tokens: object = usage(), model = 'flash', stopReason = 'stop') =>
  entry({
    type: 'message',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Answer' }],
      usage: tokens,
      provider: 'deepseek',
      model,
      api: 'openai-completions',
      stopReason,
      timestamp: Date.now(),
    },
  });

describe('turn usage from original session entries', () => {
  it('sums repeated context, cache and output once; reasoning is a subset', () => {
    const a = answer(usage(100, 20, 900, 0, 10)),
      b = answer(usage(100, 30, 0, 20, 15));
    const [turn] = projectTurnUsage([
      boundary(first, 'started'),
      user(first),
      a,
      b,
      a,
      boundary(first, 'completed'),
    ]);
    expect(turn).toMatchObject({
      input: 200,
      output: 50,
      cacheRead: 900,
      cacheWrite: 20,
      reasoning: 25,
      totalTokens: 1170,
      calls: 2,
      complete: true,
    });
    expect(turn.models).toHaveLength(1);
    expect(
      projectTurnUsage([
        boundary(first, 'started'),
        user(first),
        a,
        b,
        boundary(first, 'completed'),
      ])[0],
    ).toEqual(turn);
  });
  it('counts original retry attempts and compaction even if hidden from model projection', () => {
    const [turn] = projectTurnUsage([
      boundary(first, 'started'),
      user(first),
      answer(usage(), 'flash', 'error'),
      entry({ type: 'context_edit', edits: [] }),
      entry({ type: 'compaction', usage: usage(5, 5, 0) }),
      answer(),
      boundary(first, 'completed'),
    ]);
    expect(turn).toMatchObject({ totalTokens: 130, calls: 2, compactions: 1, complete: true });
  });
  it('assigns pre-prompt compaction and consumed follow-up/steer, ignoring queued submissions', () => {
    const turns = projectTurnUsage([
      boundary(first, 'started'),
      entry({ type: 'compaction', usage: usage() }),
      user(first),
      entry({
        type: 'custom',
        customType: 'data_agent.input_submitted',
        data: { inputId: second, kind: 'steer' },
      }),
      answer(),
      boundary(first, 'continued'),
      boundary(second, 'started'),
      user(second),
      answer(usage(1, 2, 3), 'other'),
      boundary(second, 'completed'),
    ]);
    expect(turns.map((t) => [t.inputId, t.totalTokens, t.status])).toEqual([
      [first, 120, 'continued'],
      [second, 6, 'completed'],
    ]);
    expect(turns[1].models[0].model).toBe('other');
  });
  it('marks missing/all-zero usage, crash and legacy history incomplete', () => {
    for (const tokens of [{}, usage(0, 0, 0, 0, 0)]) {
      expect(
        projectTurnUsage([
          boundary(first, 'started'),
          user(first),
          answer(tokens),
          boundary(first, 'cancelled'),
        ])[0],
      ).toMatchObject({ complete: false, totalTokens: 0, status: 'cancelled' });
    }
    const raw = [boundary(first, 'started'), user(first), answer()];
    expect(projectTurnUsage(raw)[0]).toMatchObject({
      status: 'interrupted',
      complete: false,
      totalTokens: 60,
    });
    expect(projectTurnUsage(raw, first)[0]).toMatchObject({ status: 'running', complete: true });
    expect(projectTurnUsage([user(first), answer()])[0]).toMatchObject({
      status: 'legacy',
      complete: false,
      totalTokens: 60,
    });
  });
  it('keeps auxiliary usage distinct and does not count ordinary tool output twice', () => {
    const [turn] = projectTurnUsage([
      boundary(first, 'started'),
      user(first),
      answer(),
      entry({
        type: 'message',
        message: { role: 'toolResult', content: [{ type: 'text', text: 'result' }] },
      }),
      entry({ type: 'usage', provider: 'other', model: 'other-model', usage: usage(1, 2, 3) }),
      boundary(first, 'completed'),
    ]);
    expect(turn.totalTokens).toBe(66);
    expect(turn.models).toHaveLength(2);
  });
  it('round-trips actual JSONL without duplicating token counts in custom metadata', () => {
    const dir = mkdtempSync(join(tmpdir(), 'data-agent-usage-'));
    try {
      const file = join(dir, 'session.jsonl');
      const manager = SessionManager.open(file, dir, dir);
      const ledger = new TurnUsageLedger(manager);
      manager.appendCustomEntry('data_agent.input_submitted', { inputId: first, kind: 'prompt' });
      ledger.begin(first);
      const u = user(first),
        a = answer();
      if (
        u.type !== 'message' ||
        a.type !== 'message' ||
        u.message.role !== 'user' ||
        a.message.role !== 'assistant'
      )
        throw new Error('fixture');
      manager.appendMessage(u.message);
      manager.appendMessage(a.message);
      ledger.end('completed');
      const restored = readHistory(file, dir, manager.getSessionId());
      expect(restored.turnUsage).toEqual(ledger.snapshot());
      const rows = readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(
        rows
          .filter((row) => row.type === 'custom')
          .every((row) => !JSON.stringify(row).includes('totalTokens')),
      ).toBe(true);
      expect(new TurnUsageLedger(SessionManager.open(file, dir, dir)).snapshot()).toEqual(
        ledger.snapshot(),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
