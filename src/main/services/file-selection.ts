import { realpathSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { AppError } from '../../shared/errors';
import { MAX_INPUT_BYTES, type SelectedFile } from '../../shared/models';
/** Path/metadata validation only. The workbench never parses or copies CSV content. */
export function inspectFiles(paths: string[]): SelectedFile[] {
  const unique = new Map<string, SelectedFile>();
  for (const raw of paths) {
    let path, stat;
    try {
      path = realpathSync(raw);
      stat = statSync(path);
    } catch {
      throw new AppError('FILE_NOT_FOUND', `文件不存在或无法访问：${raw}`);
    }
    if (!stat.isFile() || !path.toLowerCase().endsWith('.csv'))
      throw new AppError('INVALID_FILE', '请选择 CSV 文件');
    if (stat.size > MAX_INPUT_BYTES)
      throw new AppError('INPUT_TOO_LARGE', '单个 CSV 文件不能超过 100 MB');
    unique.set(path, { path, name: basename(path), size: stat.size });
  }
  const files = [...unique.values()];
  if (files.reduce((total, file) => total + file.size, 0) > MAX_INPUT_BYTES)
    throw new AppError('INPUT_TOO_LARGE', '选用的 CSV 总大小不能超过 100 MB');
  return files;
}
