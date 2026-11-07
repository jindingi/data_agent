import { z } from 'zod';
import {
  inputSchema,
  thinkingLevelSchema,
  modelChoiceSchema,
  type RuntimeSnapshot,
} from '../runtime';
import { interactionAnswerSchema } from '../tools';

const base = { requestId: z.string().uuid() };
export const commandSchema = z.discriminatedUnion('type', [
  z
    .object({
      ...base,
      type: z.literal('automation.control'),
      action: z.enum(['close_reopen', 'quit', 'host_pid']),
      sessionId: z.string().uuid().optional(),
    })
    .strict(),
  z.object({ ...base, type: z.literal('artifacts.list'), sessionId: z.string().uuid() }).strict(),
  z
    .object({
      ...base,
      type: z.literal('artifacts.preview'),
      sessionId: z.string().uuid(),
      artifactId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('artifacts.copy'),
      sessionId: z.string().uuid(),
      artifactId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('artifacts.export'),
      sessionId: z.string().uuid(),
      versionId: z.string().uuid(),
    })
    .strict(),
  z.object({ ...base, type: z.literal('workspace.open'), sessionId: z.string().uuid() }).strict(),
  z.object({ ...base, type: z.literal('link.open'), url: z.string().url().max(4096) }).strict(),
  z.object({ ...base, type: z.literal('system.info') }).strict(),
  z.object({ ...base, type: z.literal('models.settings') }).strict(),
  z.object({ ...base, type: z.literal('models.select'), model: modelChoiceSchema }).strict(),
  z.object({ ...base, type: z.literal('models.thinking'), level: thinkingLevelSchema }).strict(),
  z
    .object({
      ...base,
      type: z.literal('models.key'),
      provider: z.string().min(1).max(100),
      key: z.string().max(4096),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('runtime.submit'),
      sessionId: z.string().uuid(),
      input: inputSchema,
    })
    .strict(),
  z.object({ ...base, type: z.literal('runtime.activeStates') }).strict(),
  z.object({ ...base, type: z.literal('runtime.snapshot'), sessionId: z.string().uuid() }).strict(),
  z
    .object({
      ...base,
      type: z.literal('runtime.discardDraft'),
      sessionId: z.string().uuid(),
      inputId: z.string().uuid(),
    })
    .strict(),
  z.object({ ...base, type: z.literal('runtime.cancel'), sessionId: z.string().uuid() }).strict(),
  z
    .object({
      ...base,
      type: z.literal('interaction.answer'),
      interactionId: z.string().uuid(),
      sessionId: z.string().uuid(),
      runId: z.string().uuid(),
      hostEpoch: z.string().uuid(),
      digest: z.string().length(64),
      answer: interactionAnswerSchema,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('sessions.list'),
      search: z.string().max(200).default(''),
      archived: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('sessions.create'),
      chooseWorkspace: z.boolean().default(false),
    })
    .strict(),
  z
    .object({ ...base, type: z.literal('sessions.deletePreview'), sessionId: z.string().uuid() })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('sessions.delete'),
      sessionId: z.string().uuid(),
      deleteArtifacts: z.boolean(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('logs.list'),
      sessionId: z.string().uuid(),
      toolCallId: z.string().min(1).max(4096),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('logs.page'),
      sessionId: z.string().uuid(),
      logId: z.string().uuid(),
      offset: z
        .number()
        .int()
        .min(0)
        .max(10 * 1024 * 1024),
    })
    .strict(),
  z.object({ ...base, type: z.literal('sessions.open'), sessionId: z.string().uuid() }).strict(),
  z
    .object({
      ...base,
      type: z.literal('sessions.rename'),
      sessionId: z.string().uuid(),
      title: z.string().trim().min(1).max(120),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('sessions.archive'),
      sessionId: z.string().uuid(),
      archived: z.boolean(),
    })
    .strict(),
  z.object({ ...base, type: z.literal('files.pick'), sessionId: z.string().uuid() }).strict(),
  z
    .object({
      ...base,
      type: z.literal('files.add'),
      sessionId: z.string().uuid(),
      paths: z.array(z.string().min(1).max(8192).startsWith('/')).min(1).max(100),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('files.remove'),
      sessionId: z.string().uuid(),
      fileId: z.string().uuid(),
    })
    .strict(),
  z.object({ ...base, type: z.literal('system.ping'), text: z.string().max(256) }).strict(),
]);
export type Command = z.infer<typeof commandSchema>;
type Input = z.input<typeof commandSchema>;
export type CommandInput = Input extends infer T
  ? T extends Input
    ? Omit<T, 'requestId'>
    : never
  : never;
export type Result<T = unknown> =
  { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
export type HostStatus = 'starting' | 'ready' | 'exited';
export interface SystemInfo {
  version: string;
  platform: string;
  architecture: string;
  electron: string;
  node: string;
  abi: string;
  packaged: boolean;
  dataHome: string;
  workspaceRoot: string;
  hostStatus: HostStatus;
  hostPid: number | null;
  sqliteVersion: string;
}
export type AppEvent =
  | { type: 'artifacts.changed'; sessionId: string }
  | { type: 'host.status'; status: HostStatus }
  | { type: 'sessions.changed' }
  | { type: 'runtime.event'; snapshot: RuntimeSnapshot };
export interface DesktopAPI {
  addFiles: (sessionId: string, files: File[]) => Promise<Result>;
  request: (command: CommandInput) => Promise<Result>;
  subscribe: (listener: (event: AppEvent) => void) => () => void;
}
