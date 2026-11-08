import { expect, it } from 'vitest';
import { validateToolArguments } from '@earendil-works/pi-ai';
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent';
import { genericTools, toolDeclaration } from '../../../src/agent/tools';
import { toolOperationSchema } from '../../../src/shared/tools';

it.each([
  ['edit', { path: 'a', oldText: 'x', newText: 'x'.repeat(256 * 1024 + 1) }],
  ['grep', { path: '.', pattern: 'x'.repeat(1001) }],
  ['ls', { path: 'x'.repeat(4097) }],
  ['ask_clarification', { question: 'Q', options: ['x'.repeat(501)] }],
] as const)('SDK and Main both reject out-of-contract %s arguments', (name, args) => {
  expect(() =>
    validateToolArguments(toolDeclaration(name), {
      type: 'toolCall',
      id: 'bad',
      name,
      arguments: args,
    }),
  ).toThrow();
  expect(toolOperationSchema.safeParse({ name, ...args }).success).toBe(false);
});

it('enforces encoded UTF-8 bytes for written and edited text', () => {
  expect(
    toolOperationSchema.safeParse({ name: 'write', path: 'a', content: 'a'.repeat(256 * 1024) })
      .success,
  ).toBe(true);
  expect(
    toolOperationSchema.safeParse({ name: 'write', path: 'a', content: '中'.repeat(256 * 1024) })
      .success,
  ).toBe(false);
  expect(
    toolOperationSchema.safeParse({
      name: 'edit',
      path: 'a',
      oldText: 'x',
      newText: '中'.repeat(100_000),
    }).success,
  ).toBe(false);
});

it('keeps structured error details through the SDK tool adapter', async () => {
  const tools = genericTools(
    {
      execute: async () => ({
        output: 'timed out',
        isError: true,
        details: { reason: 'timeout', truncated: true },
      }),
      subscribe: () => () => {},
    },
    (value) => value,
  );
  const result = await tools
    .find((tool) => tool.name === 'bash')!
    .execute('error', { command: 'synthetic' }, undefined, undefined, {} as ExtensionToolContext);
  expect(result.isError).toBe(true);
  expect(result.details).toEqual({ reason: 'timeout', truncated: true });
});
