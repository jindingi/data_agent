import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync, existsSync, lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const lock = JSON.parse(
  readFileSync(new URL('../../resources/echarts-lock.json', import.meta.url)),
);
export function prepareReportRuntime(target = resolve('runtime/report-runtime')) {
  const root = resolve(require.resolve('echarts/package.json'), '..');
  if (JSON.parse(readFileSync(join(root, 'package.json'))).version !== lock.version)
    throw new Error('ECharts version does not match resources/echarts-lock.json');
  mkdirSync(target, { recursive: true });
  for (const [name, item] of Object.entries(lock.files)) {
    const bytes = readFileSync(join(root, item.source));
    if (
      bytes.length !== item.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== item.sha256
    )
      throw new Error(`Unverified ECharts resource: ${name}`);
    const dest = join(target, name);
    if (existsSync(dest)) {
      if (lstatSync(dest).isSymbolicLink() || !readFileSync(dest).equals(bytes))
        throw new Error(`Existing report runtime differs: ${dest}`);
    } else writeFileSync(dest, bytes, { flag: 'wx' });
  }
  return target;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  prepareReportRuntime();
