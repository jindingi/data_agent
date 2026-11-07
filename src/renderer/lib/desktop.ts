import type { CommandInput, CommandResponse } from '../../shared/contracts/ipc';
import { AppError } from '../../shared/errors';
export async function request<C extends CommandInput>(command: C): Promise<CommandResponse<C>> {
  const result = await window.dataAgent.request(command);
  if (!result.ok) throw new AppError(result.error.code, result.error.message);
  return result.value;
}
