import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

export interface AppPaths { home: string; workspace: string; sessions: string; logs: string; database: string }
export function getAppPaths(env: NodeJS.ProcessEnv, automation: boolean): AppPaths {
  if (automation && (!env.DATA_AGENT_HOME || !env.DATA_AGENT_USER_DATA)) {
    throw new Error('Automation requires isolated DATA_AGENT_HOME and DATA_AGENT_USER_DATA');
  }
  if (env.DATA_AGENT_HOME && !isAbsolute(env.DATA_AGENT_HOME)) throw new Error('DATA_AGENT_HOME must be absolute');
  if (env.DATA_AGENT_USER_DATA && !isAbsolute(env.DATA_AGENT_USER_DATA)) throw new Error('DATA_AGENT_USER_DATA must be absolute');
  const home = resolve(env.DATA_AGENT_HOME || join(homedir(), '.data_agent'));
  if (automation && (home === join(homedir(), '.data_agent') || resolve(env.DATA_AGENT_USER_DATA!) === home)) {
    throw new Error('Automation cannot use real application state or share userData with business data');
  }
  return { home, workspace: join(home, 'workspace'), sessions: join(home, 'sessions'), logs: join(home, 'logs'), database: join(home, 'state.sqlite') };
}
export function ensureAppPaths(paths: AppPaths) {
  for (const dir of [paths.home, paths.workspace, paths.sessions, paths.logs]) mkdirSync(dir, { recursive: true, mode: 0o700 });
}
