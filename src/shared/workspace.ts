import type { TextPreview } from './file-preview';
export interface WorkspaceEntry {
  id: string;
  sessionId: string;
  name: string;
  relativePath: string;
  kind: 'directory' | 'file' | 'unsupported';
  size: number;
  modifiedAt: number;
}
export interface WorkspaceListing {
  entries: WorkspaceEntry[];
  truncated: boolean;
}
export interface WorkspacePreview extends TextPreview {
  entry: WorkspaceEntry;
  image?: string;
}
