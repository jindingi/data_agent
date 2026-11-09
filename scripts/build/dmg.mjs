import { readFileSync, lstatSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';

export function diskImagePath(context) {
  const { version } = JSON.parse(readFileSync(join(context.sourceRoot, 'package.json'), 'utf8'));
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version))
    throw new Error('A valid application version is required for DMG packaging');
  return join(context.releaseDir, `Data-Agent-${version}-mac-arm64.dmg`);
}

/** Check the published bytes; full native mount/installation checks belong to packaging.dmg. */
export function inspectDiskImage(context) {
  const path = diskImagePath(context),
    stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Disk image is redirected');
  const bytes = readFileSync(path);
  if (bytes.length < 512 || bytes.subarray(-512, -508).toString('ascii') !== 'koly')
    throw new Error('Invalid UDIF disk image');
  return {
    file: basename(path),
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}
