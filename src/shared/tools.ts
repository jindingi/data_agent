import { z } from 'zod';
const path = z.string().min(1).max(4096);
export const toolOperationSchema = z.discriminatedUnion('name', [
  z
    .object({
      name: z.literal('read'),
      path,
      offset: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(2000).optional(),
    })
    .strict(),
  z.object({ name: z.literal('write'), path, content: z.string().max(256 * 1024) }).strict(),
  z
    .object({
      name: z.literal('edit'),
      path,
      oldText: z
        .string()
        .min(1)
        .max(256 * 1024),
      newText: z.string().max(256 * 1024),
    })
    .strict(),
  z
    .object({
      name: z.literal('bash'),
      command: z.string().min(1).max(100_000),
      timeout: z.number().int().min(1).max(180).optional(),
    })
    .strict(),
  z
    .object({
      name: z.literal('grep'),
      pattern: z.string().min(1).max(1000),
      path,
      ignoreCase: z.boolean().optional(),
    })
    .strict(),
  z.object({ name: z.literal('find'), pattern: z.string().max(1000), path }).strict(),
  z.object({ name: z.literal('ls'), path }).strict(),
  z
    .object({
      name: z.literal('ask_clarification'),
      question: z.string().min(1).max(4000),
      options: z.array(z.string().min(1).max(500)).max(8).optional(),
    })
    .strict(),
]);
export type ToolOperation = z.infer<typeof toolOperationSchema>;
export const interactionSchema = z
  .object({
    id: z.string().uuid(),
    sessionId: z.string().uuid(),
    runId: z.string().uuid(),
    hostEpoch: z.string().uuid(),
    toolCallId: z.string().min(1),
    kind: z.enum(['approval', 'clarification']),
    digest: z.string().length(64),
    title: z.string(),
    description: z.string(),
    options: z.array(z.string()),
  })
  .strict();
export type Interaction = z.infer<typeof interactionSchema>;
export const interactionAnswerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('approval'), decision: z.enum(['allow_once', 'deny']) }).strict(),
  z
    .object({ kind: z.literal('clarification'), answer: z.string().min(1).max(4000).nullable() })
    .strict(),
]);
export type InteractionAnswer = z.infer<typeof interactionAnswerSchema>;
export const toolResultSchema = z
  .object({
    output: z.string(),
    isError: z.boolean(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type ToolResult = z.infer<typeof toolResultSchema>;
