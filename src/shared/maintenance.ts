export interface ToolLog { id: string; runId: string; toolCallId: string; peakRss: number; reason: string | null; truncated: boolean }
export interface LogPage { text: string; offset: number; nextOffset: number | null; totalBytes: number }
export interface DeletionPreview { pending: boolean; deleteArtifacts: boolean; artifactCount: number; workspace: string; remaining: { path: string; error: string | null }[] }
export interface DeletionResult { complete: boolean; remaining: { path: string; error: string | null }[] }
