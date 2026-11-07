export interface ToolLog {
  id: string;
  runId: string;
  toolCallId: string;
}
export interface LogPage {
  text: string;
  offset: number;
  nextOffset: number | null;
  totalBytes: number;
}
export interface DeletionPreview {
  pending: boolean;
  workspace: string;
  remaining: { path: string; error: string | null }[];
}
export interface DeletionResult {
  complete: boolean;
  remaining: { path: string; error: string | null }[];
}

export interface ToolLogListing {
  logs: ToolLog[];
  nextOffset: number | null;
}
