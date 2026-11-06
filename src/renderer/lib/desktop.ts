import type { CommandInput } from '../../shared/contracts/ipc';
export async function request<T>(command: CommandInput): Promise<T> {
  const result = await window.dataAgent.request(command);
  if (!result.ok) throw new Error(result.error.message);
  return result.value as T;
}
