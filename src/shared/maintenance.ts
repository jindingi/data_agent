export interface DeletionPreview {
  pending: boolean;
  workspace: string;
  remaining: { path: string; error: string | null }[];
}
export interface DeletionResult {
  complete: boolean;
  remaining: { path: string; error: string | null }[];
}
