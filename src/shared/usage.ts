import { z } from 'zod';

const count = z.number().int().nonnegative();
export const tokenTotalsSchema = z.object({
  input: count,
  output: count,
  cacheRead: count,
  cacheWrite: count,
  reasoning: count,
  totalTokens: count,
});
export const turnUsageSchema = tokenTotalsSchema.extend({
  inputId: z.string(),
  status: z.enum([
    'running',
    'completed',
    'continued',
    'cancelled',
    'failed',
    'interrupted',
    'legacy',
  ]),
  complete: z.boolean(),
  calls: count,
  compactions: count,
  models: z.array(tokenTotalsSchema.extend({ provider: z.string(), model: z.string() })),
});
export type TokenTotals = z.infer<typeof tokenTotalsSchema>;
export type TurnUsage = z.infer<typeof turnUsageSchema>;
export const emptyTokens = (): TokenTotals => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  totalTokens: 0,
});
