import { expectTypeOf, it, expect } from 'vitest';
import type { CommandInput, CommandResponses, DesktopAPI } from '../../src/shared/contracts/ipc';
import type { SessionRecord } from '../../src/shared/models';
import { AppError } from '../../src/shared/errors';

// Compiled by pnpm check; never execute the declaration-only bridge.
export async function commandTypeChecks(api: DesktopAPI) {
  const result = await api.request({ type: 'sessions.list' });
  if (result.ok) expectTypeOf(result.value).toEqualTypeOf<SessionRecord[]>();
  // @ts-expect-error Each command owns its required request fields.
  await api.request({ type: 'sessions.open' });
  // @ts-expect-error The caller cannot invent a response DTO.
  await api.request<string>({ type: 'sessions.list' });
  // @ts-expect-error A session list response cannot be a string.
  const bad: CommandResponses['sessions.list'] = 'incorrect';
  void bad;
}
it('response map covers every command and errors retain their identity', () => {
  expectTypeOf<keyof CommandResponses>().toEqualTypeOf<CommandInput['type']>();
  const error = new AppError('INPUT_TOO_LARGE', 'too large');
  expect(error.code).toBe('INPUT_TOO_LARGE');
  expect(error.message).toBe('too large');
});
