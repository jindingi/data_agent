export type SessionState = 'creating' | 'draft' | 'persisted' | 'missing' | 'corrupt' | 'incompatible' | 'unavailable';
export interface SessionRecord {
  id: string; title: string; workspace: string; sessionFile: string; piSessionId: string | null;
  state: SessionState; error: string | null; archived: boolean; createdAt: string; updatedAt: string;
}
export interface FileReference { id: string; sessionId: string; path: string; name: string; size: number; missing: boolean }
export interface HistoryItem { id: string; role: string; text: string }
export interface SessionDetail { session: SessionRecord; files: FileReference[]; history: HistoryItem[]; messages?: import('./runtime').MessageView[] }
export const MAX_INPUT_BYTES = 100_000_000;
