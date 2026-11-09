export interface FixtureReply {
  text?: string;
  tool?: { name: string; args: Record<string, unknown> };
  tools?: { name: string; args: Record<string, unknown> }[];
  status?: number;
  error?: string;
  usage?: Record<string, unknown>;
  delay?: number;
}
export function modelFixture(): Promise<{
  baseUrl: string;
  requests: Record<string, unknown>[];
  authorizations: string[];
  setListingStatus(status: number): void;
  set(
    ...replies: (
      | FixtureReply
      | ((payload: Record<string, unknown>, call: number) => FixtureReply | Promise<FixtureReply>)
    )[]
  ): void;
  close(): Promise<void>;
}>;
