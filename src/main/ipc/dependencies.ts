import type { IpcMainInvokeEvent } from 'electron';
import type { SystemInfo } from '../../shared/contracts/ipc';
import type { AgentProcess } from '../services/agent-process';
import type { SessionService } from '../services/sessions';
import type { FilePicker } from '../services/file-picker';
import type { CredentialService } from '../services/credentials';
import type { RuntimeService } from '../services/runtime';
import type { ArtifactService } from '../services/artifacts';
import type { DeletionService } from '../services/deletion';
import type { LogService } from '../services/logs';
import type { InteractionBroker } from '../services/interactions';
export interface HandlerDependencies {
  trusted: (event: IpcMainInvokeEvent) => boolean;
  info: () => SystemInfo;
  host: AgentProcess;
  sessions: SessionService;
  picker: FilePicker;
  changed: () => void;
  credentials: CredentialService;
  runtime: RuntimeService;
  catalogReady: Promise<void>;
  interactions: InteractionBroker;
  automationControl?: (
    action: 'close_reopen' | 'quit' | 'host_pid',
    sessionId?: string,
  ) => number | null;
  artifacts: ArtifactService;
  logs: LogService;
  deletion: DeletionService;
}
