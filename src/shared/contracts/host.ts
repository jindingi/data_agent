import { agentBindingSchema } from '../agent-config';
import { z } from 'zod';
import { turnUsageSchema } from '../usage';
import {
  inputSchema,
  thinkingLevelSchema,
  modelChoiceSchema,
  snapshotSchema,
  messageSchema,
} from '../runtime';
import { toolOperationSchema, toolResultSchema, interactionSchema } from '../tools';
import { toolLimits } from '../tool-limits';
const id = z.string().uuid();
const runtimeConfigSchema = z
  .object({
    sessionId: id,
    runId: id,
    file: z.string().min(1),
    workspace: z.string().min(1),
    piSessionId: z.string().nullable(),
    model: modelChoiceSchema,
    thinkingLevel: thinkingLevelSchema.optional(),
    apiKey: z.string().min(1).max(4096),
    protectedRoots: z.array(z.string()),
    testBaseUrl: z.string().url().optional(),
    baseUrl: z.string().url().optional(),
    skillsDirectory: z.string().optional(),
    skillResourcesRoot: z.string().optional(),
    agentConfig: agentBindingSchema.optional(),
  })
  .strict();
export const hostRequestSchema = z.discriminatedUnion('type', [
  z
    .object({
      id,
      type: z.literal('agentConfig.preview'),
      binding: agentBindingSchema,
      workspace: z.string().min(1),
      history: z
        .object({ file: z.string().min(1), piSessionId: z.string().min(1) })
        .strict()
        .optional(),
    })
    .strict(),
  z.object({ id, type: z.literal('tool.result'), result: toolResultSchema }).strict(),
  z.object({ id, type: z.literal('tool.update'), output: z.string() }).strict(),
  z
    .object({ id, type: z.literal('tool.interaction'), interaction: interactionSchema.nullable() })
    .strict(),
  z.object({ id, type: z.literal('ping'), text: z.string().max(256) }).strict(),
  z
    .object({
      id,
      type: z.literal('history.read'),
      file: z.string().min(1),
      workspace: z.string().min(1),
      piSessionId: z.string().min(1),
    })
    .strict(),
  z.object({ id, type: z.literal('models.list') }).strict(),
  z
    .object({
      id,
      type: z.literal('models.test'),
      model: modelChoiceSchema,
      apiKey: z.string().min(1).max(4096),
      baseUrl: z.string().url().optional(),
    })
    .strict(),
  z
    .object({
      id,
      type: z.literal('runtime.start'),
      config: runtimeConfigSchema,
      input: inputSchema,
    })
    .strict(),
  z.object({ id, type: z.literal('runtime.input'), input: inputSchema }).strict(),
  z.object({ id, type: z.literal('runtime.cancel') }).strict(),
  z.object({ id, type: z.literal('runtime.snapshot') }).strict(),
]);
export const hostResponseSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('agentConfig.previewed'),
      id,
      text: z.string(),
      source: z.enum(['assembled', 'history']),
    })
    .strict(),
  z
    .object({
      id,
      type: z.literal('tool.request'),
      maxOutputBytes: z.number().int().nonnegative().max(toolLimits.resultBytes).optional(),
      toolCallId: z.string().min(1).max(256),
      operation: toolOperationSchema,
    })
    .strict(),
  z.object({ id, type: z.literal('tool.cancel'), toolCallId: z.string().min(1).max(256) }).strict(),
  z.object({ type: z.literal('ready'), pid: z.number().int().positive() }).strict(),
  z
    .object({ type: z.literal('pong'), id, text: z.string(), pid: z.number().int().positive() })
    .strict(),
  z
    .object({
      type: z.literal('history'),
      id,
      piSessionId: z.string(),
      items: z.array(z.object({ id: z.string(), role: z.string(), text: z.string() })),
      messages: z.array(messageSchema),
      turnUsage: z.array(turnUsageSchema),
      inputs: z.array(
        z.object({ inputId: id, state: z.literal('committed'), entryId: z.string() }),
      ),
    })
    .strict(),
  z
    .object({
      type: z.literal('models'),
      id,
      models: z.array(
        modelChoiceSchema.extend({
          name: z.string(),
          reasoning: z.boolean(),
          vision: z.boolean(),
          verified: z.boolean(),
          thinkingLevels: z.array(thinkingLevelSchema),
          baseUrl: z.string().optional(),
          api: z.string().optional(),
        }),
      ),
    })
    .strict(),
  z.object({ type: z.literal('model.tested'), id, elapsedMs: z.number() }).strict(),
  z.object({ type: z.literal('accepted'), id }).strict(),
  z.object({ type: z.literal('snapshot'), id, snapshot: snapshotSchema }).strict(),
  z.object({ type: z.literal('runtime.event'), snapshot: snapshotSchema }).strict(),
  z.object({ type: z.literal('error'), id, code: z.string(), message: z.string() }).strict(),
]);
export type HostRequest = z.infer<typeof hostRequestSchema>;
export type HostInput = HostRequest extends infer T
  ? T extends HostRequest
    ? Omit<T, 'id'>
    : never
  : never;
type HostResponse = z.infer<typeof hostResponseSchema>;
export interface HostResponses {
  'agentConfig.preview': Extract<HostResponse, { type: 'agentConfig.previewed' }>;
  ping: Extract<HostResponse, { type: 'pong' }>;
  'history.read': Extract<HostResponse, { type: 'history' }>;
  'models.list': Extract<HostResponse, { type: 'models' }>;
  'models.test': Extract<HostResponse, { type: 'model.tested' }>;
  'runtime.start': Extract<HostResponse, { type: 'accepted' }>;
  'runtime.input': Extract<HostResponse, { type: 'accepted' }>;
  'runtime.cancel': Extract<HostResponse, { type: 'accepted' }>;
  'runtime.snapshot': Extract<HostResponse, { type: 'snapshot' }>;
}
export type HostCommand = Extract<HostInput, { type: keyof HostResponses }>;
export const hostReplyTypes = {
  'agentConfig.preview': 'agentConfig.previewed',
  ping: 'pong',
  'history.read': 'history',
  'models.list': 'models',
  'models.test': 'model.tested',
  'runtime.start': 'accepted',
  'runtime.input': 'accepted',
  'runtime.cancel': 'accepted',
  'runtime.snapshot': 'snapshot',
} as const satisfies { [K in keyof HostResponses]: HostResponses[K]['type'] };
