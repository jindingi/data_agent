import { z } from 'zod';
import { interactionSchema } from './tools';

export const modelChoiceSchema = z
  .object({ provider: z.string().min(1).max(100), model: z.string().min(1).max(200) })
  .strict();
export type ModelChoice = z.infer<typeof modelChoiceSchema>;
export const thinkingLevelSchema = z.enum([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
export type ThinkingLevel = z.infer<typeof thinkingLevelSchema>;
export interface ModelOption extends ModelChoice {
  name: string;
  reasoning: boolean;
  vision: boolean;
  verified: boolean;
  thinkingLevels: ThinkingLevel[];
}
export interface ModelSettings {
  thinkingLevel: ThinkingLevel;
  selected: ModelChoice;
  models: ModelOption[];
  configuredProviders: string[];
  encryptionAvailable: boolean;
}
export const DEFAULT_MODEL: ModelChoice = { provider: 'deepseek', model: 'deepseek-flash' };
export const inputSchema = z
  .object({
    inputId: z.string().uuid(),
    kind: z.enum(['prompt', 'steer', 'followUp']),
    text: z.string().trim().min(1).max(100_000),
    paths: z.array(z.string().min(1).max(8192).startsWith('/')).max(100).optional(),
  })
  .strict();
export type RunInput = z.infer<typeof inputSchema>;
export const blockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('thinking'), text: z.string() }),
  z.object({
    type: z.literal('toolCall'),
    id: z.string(),
    name: z.string(),
    arguments: z.string(),
  }),
]);
export const messageSchema = z.object({
  id: z.string(),
  role: z.string(),
  blocks: z.array(blockSchema),
  pending: z.boolean().optional(),
  toolCallId: z.string().optional(),
  isError: z.boolean().optional(),
  inputId: z.string().uuid().optional(),
  paths: z.array(z.string()).optional(),
});
export const toolSchema = z.object({
  id: z.string(),
  name: z.string(),
  arguments: z.string(),
  output: z.string(),
  status: z.enum(['running', 'completed', 'failed']),
});
export const snapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    sessionId: z.string().uuid(),
    runId: z.string().uuid(),
    hostEpoch: z.string().uuid(),
    seq: z.number().int().nonnegative(),
    state: z.enum([
      'starting',
      'queued',
      'running',
      'waiting_approval',
      'waiting_input',
      'completed',
      'cancelled',
      'failed',
      'interrupted',
    ]),
    messages: z.array(messageSchema),
    tools: z.array(toolSchema),
    inputs: z.array(
      z.object({
        inputId: z.string().uuid(),
        kind: inputSchema.shape.kind,
        state: z.enum(['pending', 'committed', 'unknown', 'cancelled']),
        entryId: z.string().optional(),
      }),
    ),
    queuedInputs: z.array(inputSchema).optional(),
    unsentInputs: z.array(inputSchema).optional(),
    error: z.string().nullable(),
    requests: z
      .array(
        z.object({
          model: z.string(),
          toolNames: z.array(z.string()),
          userMessages: z.number(),
          toolResultHashes: z.array(z.string()),
          hasReasoning: z.boolean(),
          hasNonemptyReasoning: z.boolean(),
          hasInternalEnvelope: z.boolean(),
          thinkingEnabled: z.boolean(),
          reasoningEffort: z.string(),
        }),
      )
      .optional(),
    usage: z
      .object({
        input: z.number(),
        output: z.number(),
        cacheRead: z.number(),
        cacheWrite: z.number(),
        totalTokens: z.number(),
      })
      .optional(),
    responseModel: z.string().optional(),
    interactions: z.array(interactionSchema).optional(),
    outputDirectory: z.string().optional(),
    activity: z
      .object({
        kind: z.enum(['retry', 'compaction']),
        attempt: z.number().optional(),
        maxAttempts: z.number().optional(),
        reason: z.string().optional(),
      })
      .nullable()
      .optional(),
  })
  .strict();
export type RuntimeSnapshot = z.infer<typeof snapshotSchema>;
export type MessageView = z.infer<typeof messageSchema>;
export type ToolView = z.infer<typeof toolSchema>;
export function terminalTools(messages: MessageView[]): ToolView[] {
  return messages.flatMap((message) =>
    message.blocks.flatMap((block) => {
      if (block.type !== 'toolCall') return [];
      const result = messages.find((item) => item.toolCallId === block.id);
      return [
        {
          id: block.id,
          name: block.name,
          arguments: block.arguments,
          status: result && !result.isError ? ('completed' as const) : ('failed' as const),
          output:
            result?.blocks
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n') || '执行已结束，未收到完整工具结果',
        },
      ];
    }),
  );
}
export function isActive(state: RuntimeSnapshot['state']) {
  return ['starting', 'queued', 'running', 'waiting_approval', 'waiting_input'].includes(state);
}
/** Cross-epoch changes are accepted only through an authoritative snapshot response. */
export function acceptSnapshot(
  current: RuntimeSnapshot | null,
  incoming: RuntimeSnapshot,
  sessionId: string,
  authoritative = false,
): RuntimeSnapshot | null {
  if (incoming.sessionId !== sessionId) return current;
  if (!current) return authoritative ? incoming : current;
  if (current.hostEpoch !== incoming.hostEpoch || current.runId !== incoming.runId)
    return authoritative ? incoming : current;
  return incoming.seq > current.seq || (authoritative && incoming.seq === current.seq)
    ? incoming
    : current;
}
