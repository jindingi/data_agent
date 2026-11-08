import { z } from 'zod';
import { toolLimits } from './tool-limits';
const path = z
  .string()
  .min(1)
  .max(toolLimits.pathChars)
  .describe('Absolute path or a path relative to the session workspace.');
const text = z
  .string()
  .max(toolLimits.textBytes)
  .refine(
    (value) => new TextEncoder().encode(value).byteLength <= toolLimits.textBytes,
    `UTF-8 text must not exceed ${toolLimits.textBytes} bytes`,
  )
  .describe(`UTF-8 text, at most ${toolLimits.textBytes} encoded bytes.`);
/** One parameter contract generates both provider declarations and Main validation. */
export const toolParameters = {
  read: z
    .object({
      path,
      offset: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('1-based starting line. Cannot be combined with byteOffset.'),
      byteOffset: z
        .number()
        .int()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER)
        .optional()
        .describe(
          'UTF-8 byte position, starting at zero. Use the nextByteOffset returned by read to continue, including within long lines.',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(toolLimits.maxReadLines)
        .optional()
        .describe(`Maximum lines to return, default ${toolLimits.readLines}.`),
    })
    .strict(),
  write: z.object({ path, content: text }).strict(),
  edit: z.object({ path, oldText: text.min(1), newText: text }).strict(),
  bash: z
    .object({
      command: z.string().min(1).max(toolLimits.commandChars),
      timeout: z.number().int().min(1).max(toolLimits.timeoutSeconds).optional(),
    })
    .strict(),
  grep: z
    .object({
      pattern: z.string().min(1).max(toolLimits.patternChars),
      path,
      ignoreCase: z.boolean().optional(),
      literal: z.boolean().optional(),
      limit: z.number().int().min(1).max(toolLimits.maxSearchMatches).optional(),
      offset: z
        .number()
        .int()
        .min(0)
        .max(Number.MAX_SAFE_INTEGER)
        .optional()
        .describe('Number of matches to skip. Continue with the returned nextOffset.'),
    })
    .strict(),
  find: z
    .object({
      pattern: z.string().max(toolLimits.patternChars),
      path,
      limit: z.number().int().min(1).max(toolLimits.maxDirectoryEntries).optional(),
      offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    })
    .strict(),
  ls: z
    .object({
      path,
      limit: z.number().int().min(1).max(toolLimits.maxDirectoryEntries).optional(),
      offset: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
    })
    .strict(),
  ask_clarification: z
    .object({
      question: z.string().min(1).max(toolLimits.questionChars),
      options: z
        .array(z.string().min(1).max(toolLimits.optionChars))
        .max(toolLimits.options)
        .optional(),
    })
    .strict(),
};
export const toolNames = Object.keys(toolParameters) as (keyof typeof toolParameters)[];
export const toolOperationSchema = z.discriminatedUnion('name', [
  toolParameters.read.extend({ name: z.literal('read') }),
  toolParameters.write.extend({ name: z.literal('write') }),
  toolParameters.edit.extend({ name: z.literal('edit') }),
  toolParameters.bash.extend({ name: z.literal('bash') }),
  toolParameters.grep.extend({ name: z.literal('grep') }),
  toolParameters.find.extend({ name: z.literal('find') }),
  toolParameters.ls.extend({ name: z.literal('ls') }),
  toolParameters.ask_clarification.extend({ name: z.literal('ask_clarification') }),
]);
export type ToolOperation = z.infer<typeof toolOperationSchema>;
export const interactionSchema = z
  .object({
    id: z.string().uuid(),
    sessionId: z.string().uuid(),
    runId: z.string().uuid(),
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
    details: z
      .object({
        truncated: z.boolean().optional(),
        truncationReason: z
          .enum(['bytes', 'lines', 'entries', 'matches', 'scope', 'capture'])
          .optional(),
        nextByteOffset: z.number().int().nonnegative().optional(),
        nextOffset: z.number().int().nonnegative().optional(),
        scannedBytes: z.number().int().nonnegative().optional(),
        returnedBytes: z.number().int().nonnegative().optional(),
        scopeTruncated: z.boolean().optional(),
        linesTruncated: z.boolean().optional(),
        exitCode: z.number().int().nullable().optional(),
        reason: z.string().optional(),
        peakRss: z.number().nonnegative().optional(),
        pid: z.number().int().nullable().optional(),
        logPath: z.string().optional(),
        logComplete: z.boolean().optional(),
        logBytes: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ToolResult = z.infer<typeof toolResultSchema>;
