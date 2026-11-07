export type SessionState =
  | 'creating'
  | 'draft'
  | 'persisted'
  | 'missing'
  | 'corrupt'
  | 'incompatible'
  | 'unavailable'
  | 'deleting';
export interface SessionRecord {
  id: string;
  title: string;
  workspace: string;
  sessionFile: string;
  piSessionId: string | null;
  state: SessionState;
  error: string | null;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface SelectedFile {
  path: string;
  name: string;
  size: number;
}
export interface HistoryItem {
  id: string;
  role: string;
  text: string;
}
export interface SessionDetail {
  session: SessionRecord;
  history: HistoryItem[];
  messages?: import('./runtime').MessageView[];
}
export const MAX_INPUT_BYTES = 100_000_000;
