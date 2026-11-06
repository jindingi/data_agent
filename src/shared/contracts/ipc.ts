import { z } from 'zod';

const base = { requestId: z.string().uuid() };
export const commandSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('system.info') }).strict(),
  z.object({ ...base, type: z.literal('system.ping'), text: z.string().max(256) }).strict(),
]);
export type Command = z.infer<typeof commandSchema>;
export type CommandInput = Command extends infer T ? T extends Command ? Omit<T, 'requestId'> : never : never;
export type Result<T = unknown> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } };
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
export type AppEvent = { type: 'host.status'; status: HostStatus };
export interface DesktopAPI {
  request: (command: CommandInput) => Promise<Result>;
  subscribe: (listener: (event: AppEvent) => void) => () => void;
}
