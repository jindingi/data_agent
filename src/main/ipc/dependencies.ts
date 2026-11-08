import type { HtmlReportService } from '../services/html-reports';
import type { WorkspaceFileService } from '../services/workspace';
import type { AgentConfigService } from '../services/agent-config';
import type { IpcMainInvokeEvent } from 'electron';
import type { SystemInfo } from '../../shared/contracts/ipc';
import type { AgentProcess } from '../services/agent-process';
import type { SessionService } from '../services/sessions';
import type { FilePicker } from '../services/file-picker';
import type { CredentialService } from '../services/credentials';
import type { RuntimeService } from '../services/runtime';
import type { DeletionService } from '../services/deletion';
import type { InteractionBroker } from '../services/interactions';
export interface HandlerDependencies {
  reports: HtmlReportService;
  agentConfigs: AgentConfigService;
  trusted: (event: IpcMainInvokeEvent) => boolean;
  info: () => SystemInfo;
  host: AgentProcess;
  sessions: SessionService;
  picker: FilePicker;
  changed: () => void;
  credentials: CredentialService;
  runtime: RuntimeService;
  catalogReady: Promise<void>;
  testBaseUrl?: string | undefined;
  interactions: InteractionBroker;
  automationControl?: (
    action: 'close_reopen' | 'quit' | 'host_pid',
    sessionId?: string,
  ) => number | null;
  workspaceFiles: WorkspaceFileService;
  deletion: DeletionService;
}
