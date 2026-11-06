export type ArtifactKind = 'markdown' | 'png' | 'file';
export type ArtifactState = 'ready' | 'empty' | 'unsupported' | 'too_large' | 'invalid' | 'changed' | 'missing';
export interface ArtifactRecord {
  id: string; sessionId: string; runId: string; versionId: string; path: string; relativePath: string;
  kind: ArtifactKind; state: ArtifactState; size: number; sha256: string; error: string | null; createdAt: string;
}
export interface OutputVersion { id: string; sessionId: string; runId: string; directory: string; state: 'open' | 'published'; error: string | null; createdAt: string }
export interface ArtifactListing { versions: OutputVersion[]; files: ArtifactRecord[] }
export interface ArtifactPreview { artifact: ArtifactRecord; text?: string; image?: string }
