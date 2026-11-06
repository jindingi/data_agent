import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, lstatSync, readlinkSync, writeFileSync, rmSync, renameSync } from 'node:fs';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const lock = JSON.parse(readFileSync('resources/runtime-lock.json', 'utf8'));
const target = resolve('runtime/darwin-arm64');
const staging = resolve('runtime/.prepare');
const allowDownload = process.argv.includes('--download');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
function check(file, expected) { if (hash(file) !== expected) throw new Error(`Runtime integrity mismatch: ${file}`); }
function download(url, file, digest) {
  if (!existsSync(file)) {
    if (!allowDownload) throw new Error('Runtime source missing. Use pnpm runtime:prepare -- --download on the build machine.');
    execFileSync('/usr/bin/curl', ['--fail', '--location', '--retry', '2', url, '-o', file], { stdio: 'inherit' });
  }
  if (digest) check(file, digest);
}
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This MVP runtime targets macOS arm64');
mkdirSync('runtime', { recursive: true });
rmSync(staging, { recursive: true, force: true }); mkdirSync(staging, { recursive: true });
const cache = resolve('runtime/downloads'); mkdirSync(cache, { recursive: true });
try {
  const source = resolve('validation/runtime/python/cpython-3.12.12-macos-aarch64-none');
  if (existsSync(source)) {
    check(join(source, 'bin/python3.12'), lock.python.executableSha256);
    if (readFileSync(join(source, 'BUILD'), 'utf8').trim() !== lock.python.build) throw new Error('Cached Python build mismatch');
    cpSync(source, join(staging, 'python'), { recursive: true, verbatimSymlinks: true });
  } else {
    const archive = join(cache, 'python.tar.gz'); download(lock.python.url, archive, lock.python.sha256);
    execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', staging]);
  }
  const python = join(staging, 'python/bin/python3.12'); check(python, lock.python.executableSha256);
  // Reinstall into the copied runtime from hashed wheels: no unverified cached package bytes.
  execFileSync('uv', ['pip', 'install', '--python', python, '--break-system-packages', '--require-hashes', '--only-binary', ':all:', '--reinstall', ...(allowDownload ? [] : ['--offline']), '-r', resolve('resources/requirements.hashed.lock')], {
    stdio: 'inherit', env: { ...process.env, UV_CACHE_DIR: resolve('validation/runtime/cache') },
  });
  mkdirSync(join(staging, 'bin')); mkdirSync(join(staging, 'licenses'));
  for (const tool of lock.tools) {
    let source = resolve('validation/runtime/tools', tool.folder);
    if (!existsSync(source)) {
      const archive = join(cache, `${tool.name}.tar.gz`); download(tool.url, archive, tool.sha256);
      execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', cache]); source = join(cache, tool.folder);
    }
    check(join(source, tool.name), tool.executableSha256); cpSync(join(source, tool.name), join(staging, 'bin', tool.name));
    const licenses = readdirSync(source).filter(name => /^(LICENSE|COPYING|UNLICENSE)/.test(name));
    if (!licenses.length) throw new Error(`Missing license for ${tool.name}`);
    mkdirSync(join(staging, 'licenses', tool.name)); for (const name of licenses) cpSync(join(source, name), join(staging, 'licenses', tool.name, name));
  }
  mkdirSync(join(staging, 'fonts'));
  const cachedFont = resolve('validation/runtime/fonts', lock.font.name);
  const font = existsSync(cachedFont) ? cachedFont : join(cache, lock.font.name);
  if (!existsSync(font)) download(lock.font.url, font, lock.font.sha256);
  check(font, lock.font.sha256); cpSync(font, join(staging, 'fonts', lock.font.name));
  const cachedLicense = resolve('validation/runtime/fonts/LICENSE');
  const license = existsSync(cachedLicense) ? cachedLicense : join(cache, 'font-LICENSE');
  if (!existsSync(license)) download(lock.font.licenseUrl, license);
  if (!readFileSync(license, 'utf8').includes('SIL OPEN FONT LICENSE')) throw new Error('Unexpected font license');
  cpSync(license, join(staging, 'licenses/font-OFL.txt'));
  function clean(directory) {
    for (const name of readdirSync(directory)) {
      const file = join(directory, name), stat = lstatSync(file);
      if (name === '__pycache__' || name.endsWith('.pyc')) rmSync(file, { recursive: true, force: true });
      else if (stat.isDirectory()) clean(file);
      else if (stat.isFile() && relative(join(staging, 'python/bin'), file).split('/').length === 1 && stat.size < 5000) {
        const text = readFileSync(file, 'utf8');
        if (text.startsWith('#!') && text.split('\n')[0].includes('python')) writeFileSync(file, text.replace(/^#![^\n]+/, '#!/usr/bin/env python3'));
      }
    }
  }
  clean(staging);
  const versions = JSON.parse(execFileSync(python, ['-I', '-B', '-c', 'import json,importlib.metadata; print(json.dumps({name:importlib.metadata.version(name) for name in '+JSON.stringify(Object.keys(lock.libraries))+'}))'], { encoding: 'utf8' }));
  if (JSON.stringify(versions) !== JSON.stringify(lock.libraries)) throw new Error('Library version mismatch');
  const files = {};
  function inventory(directory) { for (const name of readdirSync(directory).sort()) {
    const file = join(directory, name), stat = lstatSync(file), key = relative(staging, file);
    if (stat.isSymbolicLink()) files[key] = { link: readlinkSync(file) };
    else if (stat.isDirectory()) inventory(file);
    else files[key] = { sha256: hash(file), size: stat.size };
  } }
  inventory(staging);
  writeFileSync(join(staging, 'manifest.json'), JSON.stringify({ schemaVersion: 1, platform: lock.platform, python: lock.python.version, build: lock.python.build, libraries: versions, lockHash: hash('resources/runtime-lock.json'), files }, null, 2));
  rmSync(target, { recursive: true, force: true }); renameSync(staging, target);
  console.log(`Prepared ${lock.platform} runtime with ${Object.keys(files).length} verified inventory entries.`);
} finally { rmSync(staging, { recursive: true, force: true }); }
