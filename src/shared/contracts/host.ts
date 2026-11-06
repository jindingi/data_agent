import { z } from 'zod';
import { inputSchema, modelChoiceSchema, snapshotSchema, messageSchema } from '../runtime';
import { toolOperationSchema, toolResultSchema, interactionSchema } from '../tools';
const id = z.string().uuid();
const runtimeConfigSchema = z.object({ sessionId: id, runId: id, hostEpoch: id, file: z.string().min(1), workspace: z.string().min(1), piSessionId: z.string().nullable(), model: modelChoiceSchema, apiKey: z.string().min(1).max(4096), protectedRoots: z.array(z.string()), filePaths: z.array(z.string()), testBaseUrl: z.string().url().optional() }).strict();
export const hostRequestSchema = z.discriminatedUnion('type', [
  z.object({ id, type: z.literal('tool.result'), result: toolResultSchema }).strict(),
  z.object({ id, type: z.literal('tool.update'), output: z.string() }).strict(),
  z.object({ id, type: z.literal('tool.interaction'), interaction: interactionSchema.nullable() }).strict(),
  z.object({ id, type: z.literal('ping'), text: z.string().max(256) }).strict(),
  z.object({ id, type: z.literal('history.read'), file: z.string().min(1), workspace: z.string().min(1), piSessionId: z.string().min(1) }).strict(),
  z.object({ id, type: z.literal('models.list') }).strict(),
  z.object({ id, type: z.literal('runtime.start'), config: runtimeConfigSchema, input: inputSchema }).strict(),
  z.object({ id, type: z.literal('runtime.input'), input: inputSchema }).strict(),
  z.object({ id, type: z.literal('runtime.cancel') }).strict(),
  z.object({ id, type: z.literal('runtime.snapshot') }).strict(),
]);
export const hostResponseSchema = z.discriminatedUnion('type', [
  z.object({ id, type: z.literal('tool.request'), toolCallId: z.string().min(1).max(256), operation: toolOperationSchema }).strict(),
  z.object({ id, type: z.literal('tool.cancel'), toolCallId: z.string().min(1).max(256) }).strict(),
  z.object({ type: z.literal('ready'), pid: z.number().int().positive() }).strict(),
  z.object({ type: z.literal('pong'), id, text: z.string(), pid: z.number().int().positive() }).strict(),
  z.object({ type: z.literal('history'), id, piSessionId: z.string(), items: z.array(z.object({ id: z.string(), role: z.string(), text: z.string() })), messages: z.array(messageSchema) }).strict(),
  z.object({ type: z.literal('models'), id, models: z.array(modelChoiceSchema.extend({ name: z.string(), reasoning: z.boolean(), vision: z.boolean(), verified: z.boolean() })) }).strict(),
  z.object({ type: z.literal('accepted'), id }).strict(),
  z.object({ type: z.literal('snapshot'), id, snapshot: snapshotSchema }).strict(),
  z.object({ type: z.literal('runtime.event'), snapshot: snapshotSchema }).strict(),
  z.object({ type: z.literal('error'), id, code: z.string(), message: z.string() }).strict(),
]);
export type HostRequest = z.infer<typeof hostRequestSchema>;
export type HostInput = HostRequest extends infer T ? T extends HostRequest ? Omit<T, 'id'> : never : never;
