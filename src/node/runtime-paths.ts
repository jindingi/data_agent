import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { AppError } from '../shared/errors';
export interface RuntimePaths { root: string; python: string; bin: string; font: string; helpers: string }
export function getRuntimePaths(appPath: string, resourcesPath: string, packaged: boolean): RuntimePaths {
  const root = packaged ? join(resourcesPath, 'runtime') : join(appPath, 'runtime/darwin-arm64');
  return { root, python: join(root, 'python/bin/python3.12'), bin: join(root, 'bin'), font: join(root, 'fonts/NotoSansCJKsc-Regular.otf'), helpers: packaged ? join(resourcesPath, 'python') : join(appPath, 'resources/python') };
}
export function requireRuntime(paths: RuntimePaths) {
  for (const file of [paths.python, join(paths.root, 'manifest.json'), paths.font, join(paths.bin, 'rg'), join(paths.bin, 'fd'), join(paths.helpers, 'supervisor.py'), join(paths.helpers, 'inspect_policy.py')]) {
    if (!existsSync(file)) throw new AppError('RUNTIME_MISSING', '内置分析运行时不完整，请重新构建或安装应用。');
  }
}
