import { z } from 'zod';
const id = z.string().uuid();
export const hostRequestSchema = z.discriminatedUnion('type', [
  z.object({ id, type: z.literal('ping'), text: z.string().max(256) }).strict(),
  z.object({ id, type: z.literal('history.read'), file: z.string().min(1), workspace: z.string().min(1), piSessionId: z.string().min(1) }).strict(),
]);
export const hostResponseSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), pid: z.number().int().positive() }).strict(),
  z.object({ type: z.literal('pong'), id, text: z.string(), pid: z.number().int().positive() }).strict(),
  z.object({ type: z.literal('history'), id, piSessionId: z.string(), items: z.array(z.object({ id: z.string(), role: z.string(), text: z.string() })) }).strict(),
  z.object({ type: z.literal('error'), id, code: z.string(), message: z.string() }).strict(),
]);
export type HostRequest = z.infer<typeof hostRequestSchema>;
export type HostInput = HostRequest extends infer T ? T extends HostRequest ? Omit<T, 'id'> : never : never;
