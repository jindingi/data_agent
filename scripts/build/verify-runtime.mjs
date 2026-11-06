import assert from 'node:assert/strict';
import { readFileSync, readdirSync, lstatSync, readlinkSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
export function verifyRuntime(root = resolve('runtime/darwin-arm64')) {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  const lock = JSON.parse(readFileSync('resources/runtime-lock.json', 'utf8'));
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.lockHash, hash('resources/runtime-lock.json'));
  assert.equal(manifest.platform, lock.platform); assert.equal(manifest.python, lock.python.version); assert.deepEqual(manifest.libraries, lock.libraries);
  const actual = [];
  function walk(dir) { for (const name of readdirSync(dir)) {
    const file = join(dir, name), stat = lstatSync(file), key = relative(root, file);
    if (stat.isDirectory()) { walk(file); continue; }
    if (key === 'manifest.json') continue;
    actual.push(key); const expected = manifest.files[key]; assert(expected, `Unmanifested runtime file: ${key}`);
    if (stat.isSymbolicLink()) {
      const link = readlinkSync(file); assert.equal(link, expected.link);
      const destination = relative(root, resolve(dir, link)); assert(!isAbsolute(link) && !destination.startsWith('../') && destination !== '..', `Escaping runtime symlink: ${key}`);
    } else { assert.equal(stat.size, expected.size, key); assert.equal(hash(file), expected.sha256, key); }
  } }
  walk(root); assert.deepEqual(actual.sort(), Object.keys(manifest.files).sort());
  for (const [name, expected] of [['python/bin/python3.12', lock.python.executableSha256], ...lock.tools.map(tool => [`bin/${tool.name}`, tool.executableSha256]), [`fonts/${lock.font.name}`, lock.font.sha256]]) assert.equal(hash(join(root, name)), expected);
  return { entries: actual.length, python: manifest.python, libraries: manifest.libraries, platform: manifest.platform };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(verifyRuntime(process.argv[2] ? resolve(process.argv[2]) : undefined)));
