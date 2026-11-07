import { z } from 'zod';
import type { SessionEntry, SessionManager } from '@earendil-works/pi-coding-agent';
import { emptyTokens, type TokenTotals, type TurnUsage } from '../shared/usage';
import { inputId, messageText } from './input-identity';

const boundarySchema = z.object({
  version: z.literal(1),
  inputId: z.string().uuid(),
  state: z.enum(['started', 'completed', 'continued', 'cancelled', 'failed']),
});
const rawUsageSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
  reasoning: z.number().int().nonnegative().optional(),
});
const boundaryType = 'data_agent.usage_boundary';

/** Read original entries, not the compacted model projection or UI's visible page.
 * Raw messages own token counts; custom entries only mark ownership/lifecycle.
 */
export function projectTurnUsage(entries: SessionEntry[], activeInput?: string): TurnUsage[] {
  const turns = new Map<string, TurnUsage>();
  const seen = new Set<string>();
  let current: TurnUsage | undefined;
  function get(id: string) {
    let turn = turns.get(id);
    if (!turn) {
      turn = {
        ...emptyTokens(),
        inputId: id,
        status: 'legacy',
        complete: false,
        calls: 0,
        compactions: 0,
        models: [],
      };
      turns.set(id, turn);
    }
    return turn;
  }
  function add(raw: unknown, provider: string, model: string) {
    if (!current) return;
    const parsed = rawUsageSchema.safeParse(raw);
    if (!parsed.success) {
      current.complete = false;
      return;
    }
    const value = parsed.data;
    const total = value.input + value.output + value.cacheRead + value.cacheWrite;
    // SDK initializes usage to zeros even when no server usage chunk was received.
    if (total === 0) {
      current.complete = false;
      return;
    }
    const tokens: TokenTotals = { ...value, reasoning: value.reasoning ?? 0, totalTokens: total };
    let group = current.models.find((item) => item.provider === provider && item.model === model);
    if (!group) {
      group = { ...emptyTokens(), provider, model };
      current.models.push(group);
    }
    for (const key of Object.keys(tokens) as (keyof TokenTotals)[]) {
      current[key] += tokens[key];
      group[key] += tokens[key];
    }
  }
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    if (entry.type === 'custom' && entry.customType === boundaryType) {
      const result = boundarySchema.safeParse(entry.data);
      if (!result.success) continue;
      const { inputId: id, state } = result.data;
      const turn = get(id);
      if (state === 'started') {
        current = turn;
        turn.status = id === activeInput ? 'running' : 'interrupted';
        turn.complete = true;
      } else {
        turn.status = state;
        if (current === turn) current = undefined;
      }
      continue;
    }
    if (entry.type === 'message') {
      const message = entry.message;
      if (message.role === 'user') {
        current = get(inputId(messageText(message)) ?? entry.id);
      } else if (message.role === 'assistant' && current) {
        current.calls++;
        add(message.usage, message.provider, message.responseModel ?? message.model);
      } else if (message.role === 'toolResult' && message.usage) {
        add(message.usage, '', '工具内部模型调用');
      }
    } else if (entry.type === 'compaction' || entry.type === 'branch_summary') {
      if (current) {
        current.compactions++;
        add(entry.usage, '', '上下文摘要');
      }
    } else if (entry.type === 'usage') {
      add(entry.usage, entry.provider, entry.model);
    }
  }
  return [...turns.values()].map((turn) => ({
    ...turn,
    complete: turn.complete && !['interrupted', 'legacy'].includes(turn.status),
  }));
}

/** One writer, alongside native session persistence. Never persist duplicate token totals. */
export class TurnUsageLedger {
  private activeInput?: string;
  private value: TurnUsage[];
  constructor(private manager: SessionManager) {
    this.value = projectTurnUsage(manager.getEntries());
  }
  begin(id: string) {
    if (id === this.activeInput) return;
    this.end('continued');
    this.manager.appendCustomEntry(boundaryType, { version: 1, inputId: id, state: 'started' });
    this.activeInput = id;
    this.refresh();
  }
  end(state: 'completed' | 'cancelled' | 'failed' | 'continued') {
    if (!this.activeInput) return;
    this.manager.appendCustomEntry(boundaryType, { version: 1, inputId: this.activeInput, state });
    this.activeInput = undefined;
    this.refresh();
  }
  refresh() {
    this.value = projectTurnUsage(this.manager.getEntries(), this.activeInput);
  }
  snapshot() {
    return this.value;
  }
}
