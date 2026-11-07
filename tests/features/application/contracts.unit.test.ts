import { describe, expect, it } from 'vitest';
import { commandSchema } from '../../../src/shared/contracts/ipc';
import { hostRequestSchema } from '../../../src/shared/contracts/host';
import { getAppPaths } from '../../../src/node/app-paths';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

describe('desktop trust boundary', () => {
  it('accepts only typed known commands, forbids unrecognized payloads', () => {
    const id = randomUUID();
    expect(commandSchema.safeParse({ type: 'system.info', requestId: id }).success).toBe(true);
    expect(
      commandSchema.safeParse({ type: 'run.shell', requestId: id, command: 'anything' }).success,
    ).toBe(false);
    expect(
      commandSchema.safeParse({ type: 'system.info', requestId: id, unexpected: 'bad' }).success,
    ).toBe(false);
    expect(
      commandSchema.safeParse({ type: 'system.ping', requestId: id, text: 'a'.repeat(257) })
        .success,
    ).toBe(false);
    expect(hostRequestSchema.safeParse({ type: 'ping', id, text: 'valid' }).success).toBe(true);
    expect(
      hostRequestSchema.safeParse({ type: 'ping', id, text: {}, command: 'bad' }).success,
    ).toBe(false);
  });
  it('requires isolated automation roots and rejects accidental real state', () => {
    expect(() => getAppPaths({}, true)).toThrow();
    expect(() => getAppPaths({ DATA_AGENT_HOME: 'relative' }, false)).toThrow();
    expect(() =>
      getAppPaths(
        { DATA_AGENT_HOME: join(homedir(), '.data_agent'), DATA_AGENT_USER_DATA: '/tmp/ua' },
        true,
      ),
    ).toThrow();
    expect(() =>
      getAppPaths({ DATA_AGENT_HOME: '/tmp/da', DATA_AGENT_USER_DATA: '/tmp/da' }, true),
    ).toThrow();
    expect(
      getAppPaths({ DATA_AGENT_HOME: '/tmp/da', DATA_AGENT_USER_DATA: '/tmp/ua' }, true).database,
    ).toBe('/tmp/da/state.sqlite');
  });
});
