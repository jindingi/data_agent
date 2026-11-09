import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export const catalog = JSON.parse(
  readFileSync(new URL('../../tests/catalog.json', import.meta.url), 'utf8'),
);
export const aliases = JSON.parse(
  readFileSync(new URL('../../tests/legacy-aliases.json', import.meta.url), 'utf8'),
);
export function validateCatalog(entries = catalog) {
  const ids = new Set();
  for (const item of entries) {
    if (!/^[a-z][a-z0-9-]*\.[a-z0-9.-]+$/.test(item.id) || ids.has(item.id))
      throw new Error(`Duplicate or invalid test ID: ${item.id}`);
    ids.add(item.id);
    if (
      !['unit', 'integration', 'e2e', 'tooling'].includes(item.level) ||
      !['none', 'scripted', 'replay', 'live'].includes(item.model) ||
      !['node', 'electron-node', 'dev', 'built', 'packaged'].includes(item.environment)
    )
      throw new Error(`Incomplete test metadata: ${item.id}`);
    if (
      item.feature !== item.id.split('.')[0] ||
      !Array.isArray(item.tags) ||
      !Array.isArray(item.related) ||
      !existsSync(resolve(item.file))
    )
      throw new Error(`Invalid test file/features: ${item.id}`);
  }
  return entries;
}
validateCatalog();
for (const [alias, id] of Object.entries(aliases))
  if (!catalog.some((test) => test.id === id)) throw new Error(`Unknown alias target: ${alias}`);
export function resolveCase(id) {
  return aliases[id] ?? id;
}
export function requirementsFor(entries) {
  const items = entries.map((entry) =>
    typeof entry === 'string' ? catalog.find((item) => item.id === resolveCase(entry)) : entry,
  );
  if (items.some((entry) => !entry)) throw new Error('Unknown case requirement');
  return {
    build: items.some((item) => ['built', 'packaged'].includes(item.environment)),
    packaged: items.some((item) => item.environment === 'packaged'),
    dmg: items.some((item) => item.tags.includes('dmg')),
    live: items.some((item) => item.model === 'live'),
  };
}
