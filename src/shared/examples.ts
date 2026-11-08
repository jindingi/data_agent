export interface ExampleStatus {
  sessions: { id: string; title: string; report: string }[];
  error?: string;
  initialSessionId?: string;
}
