import { z } from 'zod';
export const hostRequestSchema = z.object({
  id: z.string().uuid(), type: z.literal('ping'), text: z.string().max(256),
}).strict();
export const hostResponseSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), pid: z.number().int().positive() }).strict(),
  z.object({ type: z.literal('pong'), id: z.string().uuid(), text: z.string(), pid: z.number().int().positive() }).strict(),
]);
