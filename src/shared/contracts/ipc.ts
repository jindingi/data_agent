import type { ExampleStatus } from '../examples';
import type { HtmlReportState } from '../html-report';
import type { WorkspaceEntry, WorkspaceListing, WorkspacePreview } from '../workspace';
import {
  agentConfigSchema,
  type AgentConfigSettings,
  type SessionAgentConfig,
  type AgentPromptView,
} from '../agent-config';
import { z } from 'zod';
import {
  inputSchema,
  thinkingLevelSchema,
  modelChoiceSchema,
  type RuntimeSnapshot,
} from '../runtime';
import { interactionAnswerSchema } from '../tools';
import type { SessionRecord, SessionDetail, SelectedFile } from '../models';
import type { ModelSettings } from '../runtime';
import type { DeletionPreview, DeletionResult } from '../maintenance';

const base = { requestId: z.string().uuid() };
export const commandSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('examples.status') }).strict(),
  z.object({ ...base, type: z.literal('examples.install') }).strict(),
  z
    .object({
      ...base,
      type: z.literal('report.open'),
      id: z.string().uuid(),
      sessionId: z.string().uuid(),
      entryId: z.string().uuid(),
    })
    .strict(),
  z.object({ ...base, type: z.literal('report.close'), id: z.string().uuid() }).strict(),
  z
    .object({
      ...base,
      type: z.literal('report.layout'),
      id: z.string().uuid(),
      visible: z.boolean(),
      bounds: z
        .object({
          x: z.number().finite().min(-20000).max(20000),
          y: z.number().finite().min(-20000).max(20000),
          width: z.number().finite().min(0).max(20000),
          height: z.number().finite().min(0).max(20000),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('workspace.list'),
      sessionId: z.string().uuid(),
      directoryId: z.string().uuid().optional(),
      showHidden: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('workspace.resolve'),
      sessionId: z.string().uuid(),
      entryId: z.string().uuid(),
      href: z.string().max(8192),
    })
    .strict(),
  ...(['workspace.preview', 'workspace.copy', 'workspace.saveAs'] as const).map((type) =>
    z
      .object({
        ...base,
        type: z.literal(type),
        sessionId: z.string().uuid(),
        entryId: z.string().uuid(),
      })
      .strict(),
  ),
  z
    .object({
      ...base,
      type: z.literal('workspace.reveal'),
      sessionId: z.string().uuid(),
      entryId: z.string().uuid().optional(),
    })
    .strict(),

  z
    .object({
      ...base,
      type: z.literal('agentConfig.preview'),
      config: agentConfigSchema,
      expectedRevision: z.number().int().positive(),
    })
    .strict(),
  z.object({ ...base, type: z.literal('agentConfig.get') }).strict(),
  z
    .object({
      ...base,
      type: z.literal('agentConfig.save'),
      config: agentConfigSchema,
      expectedRevision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({ ...base, type: z.literal('sessions.agentConfig'), sessionId: z.string().uuid() })
    .strict(),
  z.object({ ...base, type: z.literal('files.choose') }).strict(),
  z.object({ ...base, type: z.literal('workspace.choose') }).strict(),
  z
    .object({
      ...base,
      type: z.literal('files.inspect'),
      paths: z.array(z.string().startsWith('/').max(8192)).max(100),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('conversation.submit'),
      sessionId: z.string().uuid().optional(),
      parent: z.string().startsWith('/').max(8192).optional(),
      input: inputSchema,
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('automation.control'),
      action: z.enum(['close_reopen', 'quit', 'host_pid']),
      sessionId: z.string().uuid().optional(),
    })
    .strict(),
  z.object({ ...base, type: z.literal('workspace.open'), sessionId: z.string().uuid() }).strict(),
  z.object({ ...base, type: z.literal('link.open'), url: z.string().url().max(4096) }).strict(),
  z.object({ ...base, type: z.literal('system.info') }).strict(),
  z.object({ ...base, type: z.literal('models.settings') }).strict(),
  z
    .object({
      ...base,
      type: z.literal('models.discover'),
      provider: z.enum(['deepseek', 'openrouter']),
    })
    .strict(),
  z
    .object({
      ...base,
      type: z.literal('models.connection'),
      provider: z.string().min(1).max(100),
      baseUrl: z.string().max(2048),
      key: z.string().trim().min(1).max(4096).optional(),
    })
    .strict(),
  z.object({ ...base, type: z.literal('models.test'), model: modelChoiceSchema }).strict(),
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
  | { type: 'report.state'; state: HtmlReportState }
  | { type: 'host.status'; status: HostStatus }
  | { type: 'sessions.changed' }
  | { type: 'runtime.event'; snapshot: RuntimeSnapshot };
export interface CommandResponses {
  'examples.status': ExampleStatus;
  'examples.install': ExampleStatus;
  'report.open': HtmlReportState;
  'report.close': null;
  'report.layout': null;
  'workspace.list': WorkspaceListing;
  'workspace.preview': WorkspacePreview;
  'workspace.resolve': WorkspaceEntry;
  'workspace.copy': null;
  'workspace.reveal': null;
  'workspace.saveAs': string | null;

  'agentConfig.preview': AgentPromptView;
  'agentConfig.get': AgentConfigSettings;
  'agentConfig.save': AgentConfigSettings;
  'sessions.agentConfig': SessionAgentConfig;
  'files.choose': SelectedFile[];
  'files.inspect': SelectedFile[];
  'workspace.choose': string | null;
  'conversation.submit': { sessionId: string; snapshot: RuntimeSnapshot };
  'automation.control': number | null;
  'system.info': SystemInfo;
  'system.ping': { type: 'pong'; id: string; text: string; pid: number };
  'models.settings': ModelSettings;
  'models.discover': ModelSettings;
  'models.connection': ModelSettings;
  'models.test': { elapsedMs: number };
  'models.select': ModelSettings;
  'models.thinking': ModelSettings;
  'models.key': ModelSettings;
  'runtime.submit': RuntimeSnapshot;
  'runtime.activeStates': Record<string, RuntimeSnapshot['state']>;
  'runtime.snapshot': RuntimeSnapshot | null;
  'runtime.discardDraft': null;
  'runtime.cancel': null;
  'interaction.answer': null;
  'sessions.list': SessionRecord[];
  'sessions.create': SessionRecord | null;
  'sessions.open': SessionDetail;
  'sessions.rename': SessionRecord;
  'sessions.archive': SessionRecord;
  'sessions.deletePreview': DeletionPreview;
  'sessions.delete': DeletionResult;
  'workspace.open': null;
  'link.open': null;
}
export type CommandResponse<C extends CommandInput> = CommandResponses[C['type']];
export interface DesktopAPI {
  inspectDroppedFiles: (files: File[]) => Promise<Result<SelectedFile[]>>;
  request: <C extends CommandInput>(command: C) => Promise<Result<CommandResponse<C>>>;
  subscribe: (listener: (event: AppEvent) => void) => () => void;
}
