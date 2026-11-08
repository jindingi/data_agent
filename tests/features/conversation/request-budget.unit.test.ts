import { afterEach, expect, it, vi } from 'vitest';
import { RequestBudget } from '../../../src/agent/request-budget';
afterEach(() => vi.useRealTimers());
it('admits 50 requests by default and rejects request 51 without increasing the count', () => {
  const budget = new RequestBudget();
  for (let i = 0; i < 50; i++) budget.consume();
  expect(budget.requests).toBe(50);
  expect(() => budget.consume()).toThrow('50 次模型请求上限');
  expect(budget.requests).toBe(50);
});
it('counts actual request admission including retries and pauses active time during human input', () => {
  vi.useFakeTimers();
  const expired = vi.fn(),
    budget = new RequestBudget(20, 1000);
  for (let i = 0; i < 20; i++) budget.consume();
  expect(() => budget.consume()).toThrow('20 次');
  expect(budget.requests).toBe(20);
  budget.resume(expired);
  vi.advanceTimersByTime(400);
  budget.pause();
  vi.advanceTimersByTime(3_600_000);
  expect(expired).not.toHaveBeenCalled();
  budget.resume(expired);
  vi.advanceTimersByTime(599);
  expect(expired).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(expired).toHaveBeenCalledTimes(1);
  budget.pause();
});
