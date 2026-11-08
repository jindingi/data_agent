import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  lstatSync,
  realpathSync,
  readdirSync,
  copyFileSync,
  cpSync,
  renameSync,
} from 'node:fs';
import { resolve, join, dirname, basename, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { prepareReportRuntime } from './report-runtime.mjs';
import { verifyRelease } from './verify-release.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const within = (path, root) => path === root || path.startsWith(root + sep);
const canonical = (path) =>
  existsSync(resolve(path))
    ? realpathSync(resolve(path))
    : join(canonical(dirname(resolve(path))), basename(path));

export function sourceFingerprint(sourceRoot = repository) {
  const hash = createHash('sha256');
  const files = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: sourceRoot, encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean);
  for (const file of [...new Set(files)].sort()) {
    const path = join(sourceRoot, file);
    if (existsSync(path)) hash.update(file).update('\0').update(readFileSync(path)).update('\0');
  }
  return hash.digest('hex');
}

function paths(root, sourceRoot) {
  root = canonical(root);
  sourceRoot = canonical(sourceRoot);
  if (
    within(sourceRoot, root) ||
    ['out', 'release'].some((name) => {
      const protectedPath = canonical(join(sourceRoot, name));
      return within(root, protectedPath) || within(protectedPath, root);
    })
  )
    throw new Error('Artifact root must be separate from the source and shared out/release');
  if (within(root, sourceRoot)) {
    try {
      execFileSync(
        'git',
        [
          'check-ignore',
          '--quiet',
          '--no-index',
          relative(sourceRoot, join(root, 'app/package.json')),
        ],
        { cwd: sourceRoot },
      );
    } catch {
      throw new Error(
        'Artifact directories inside the repository must be ignored generated output',
      );
    }
  }
  return Object.freeze({
    root,
    sourceRoot,
    appDir: join(root, 'app'),
    buildDir: join(root, 'app/out'),
    packageAppDir: join(root, 'package-app'),
    releaseDir: join(root, 'release'),
    bundlePath: join(root, 'release/mac-arm64/Data Agent.app'),
  });
}

function inventory(root) {
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('Build output directory is redirected');
  const entries = {};
  const walk = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name),
        stat = lstatSync(path);
      if (stat.isSymbolicLink())
        throw new Error(`Artifact output must not be a symbolic link: ${path}`);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) entries[relative(root, path)] = digest(readFileSync(path));
      else throw new Error(`Unsupported artifact entry: ${path}`);
    }
  };
  walk(root);
  for (const name of ['main/index.js', 'main/agent.js', 'preload/index.cjs', 'renderer/index.html'])
    if (!entries[name]) throw new Error(`Incomplete isolated build: ${name}`);
  return entries;
}

function receipt(context) {
  let value;
  try {
    value = JSON.parse(readFileSync(join(context.root, 'artifacts.json'), 'utf8'));
  } catch {
    throw new Error('Missing isolated artifact receipt; prepare a new artifact root');
  }
  if (
    value.version !== 1 ||
    value.sourceRoot !== context.sourceRoot ||
    value.fingerprint !== sourceFingerprint(context.sourceRoot)
  )
    throw new Error('Missing or stale isolated artifact source');
  return value;
}

function checkLinks(context) {
  if (lstatSync(context.appDir).isSymbolicLink())
    throw new Error('Isolated application directory is redirected');
  for (const name of ['node_modules', 'runtime', 'resources']) {
    const path = join(context.appDir, name);
    if (
      !lstatSync(path).isSymbolicLink() ||
      realpathSync(path) !== realpathSync(join(context.sourceRoot, name))
    )
      throw new Error(`Isolated app resource link differs: ${name}`);
  }
  if (
    digest(readFileSync(join(context.appDir, 'package.json'))) !==
    digest(readFileSync(join(context.sourceRoot, 'package.json')))
  )
    throw new Error('Isolated application metadata differs from its source');
}

/** No shared-directory or environment fallback, including at launch and reuse. */
export function validateArtifacts(context, { packaged = false, packagedPath } = {}) {
  if (!context?.root || !context?.sourceRoot)
    throw new Error('An explicit artifact context is required');
  const expected = paths(context.root, context.sourceRoot);
  for (const key of Object.keys(expected))
    if (context[key] !== expected[key]) throw new Error(`Artifact context path mismatch: ${key}`);
  const value = receipt(context);
  checkLinks(context);
  if (!value.build || JSON.stringify(inventory(context.buildDir)) !== JSON.stringify(value.build))
    throw new Error('Missing or changed isolated build output');
  if (packaged) {
    if (!value.packaged) throw new Error('Missing verified isolated package');
    const verified = verifyRelease(
      packagedPath ?? context.bundlePath,
      context.buildDir,
      context.sourceRoot,
    );
    if (verified.asarSha256 !== value.packaged.asarSha256)
      throw new Error('Packaged application does not match its artifact receipt');
  }
  return { ...context, fingerprint: value.fingerprint };
}

function save(context, value) {
  const temp = join(context.root, `artifacts-${randomUUID()}.tmp`);
  writeFileSync(temp, JSON.stringify(value, null, 2));
  renameSync(temp, join(context.root, 'artifacts.json'));
}

function command(label, args, context) {
  const result = spawnSync('pnpm', args, {
    cwd: context.sourceRoot,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  const output = join(context.root, `${label}.log`);
  writeFileSync(output, (result.stdout ?? '') + (result.stderr ?? ''));
  if (result.error || result.status !== 0) throw new Error(`${label} failed; see ${output}`);
}

/** Owns source, immutable build output, package output and verification together. */
export function prepareArtifacts(
  {
    root,
    build = true,
    packaged = false,
    reuseBuild = false,
    reusePackage = false,
    dev = false,
  } = {},
  adapter = {},
) {
  if ((reuseBuild || reusePackage) && !root) throw new Error('Artifact reuse requires --run-root');
  if (reusePackage && !packaged) throw new Error('--no-package requires a packaged artifact');
  if (dev && (build || packaged || reuseBuild || reusePackage))
    throw new Error('Dev artifacts cannot reuse a static build');
  const sourceRoot = adapter.sourceRoot ?? repository;
  (adapter.prepareResources ?? prepareReportRuntime)();
  const context = paths(root ?? mkdtempSync(join(tmpdir(), 'data-agent-artifacts-')), sourceRoot);
  const run = adapter.command ?? command,
    verify = adapter.verifyPackage ?? verifyRelease;
  const fingerprint = sourceFingerprint(sourceRoot);
  let value = { version: 1, sourceRoot: context.sourceRoot, fingerprint };
  if (reuseBuild || reusePackage) {
    value = receipt(context);
    checkLinks(context);
    if (!value.build || JSON.stringify(inventory(context.buildDir)) !== JSON.stringify(value.build))
      throw new Error('Missing or changed isolated build output');
  } else {
    if (existsSync(context.appDir))
      throw new Error('Artifact root already contains an app; use a new root or verified reuse');
    mkdirSync(context.appDir, { recursive: true });
    copyFileSync(join(context.sourceRoot, 'package.json'), join(context.appDir, 'package.json'));
    for (const name of ['node_modules', 'runtime', 'resources'])
      symlinkSync(join(context.sourceRoot, name), join(context.appDir, name), 'dir');
    if (build) {
      run('build', ['exec', 'electron-vite', 'build', '--outDir', context.buildDir], context);
      value.build = inventory(context.buildDir);
    }
  }
  if (sourceFingerprint(context.sourceRoot) !== fingerprint)
    throw new Error('Source changed during artifact preparation');
  // Packaging never mutates a built app or its dependency links, including on failure.
  save(context, value);
  if (packaged) {
    if (!value.build) throw new Error('Packaging requires a verified build');
    if (!reusePackage) {
      if (existsSync(context.releaseDir) || existsSync(context.packageAppDir))
        throw new Error('Package output already exists; use a new root or verified --no-package');
      run('runtime', ['runtime:verify'], context);
      mkdirSync(context.packageAppDir);
      copyFileSync(
        join(context.sourceRoot, 'package.json'),
        join(context.packageAppDir, 'package.json'),
      );
      copyFileSync(
        join(context.sourceRoot, 'pnpm-lock.yaml'),
        join(context.packageAppDir, 'pnpm-lock.yaml'),
      );
      cpSync(context.buildDir, join(context.packageAppDir, 'out'), { recursive: true });
      run(
        'package-dependencies',
        [
          '--dir',
          context.packageAppDir,
          'install',
          '--prod',
          '--frozen-lockfile',
          '--ignore-scripts',
          '--offline',
          '--node-linker=hoisted',
        ],
        context,
      );
      copyFileSync(
        join(context.sourceRoot, 'node_modules/better-sqlite3/prebuilds/darwin-arm64.node'),
        join(context.packageAppDir, 'node_modules/better-sqlite3/prebuilds/darwin-arm64.node'),
      );
      run(
        'package',
        [
          'exec',
          'electron-builder',
          '--mac',
          'dir',
          '--arm64',
          `--config.directories.app=${context.packageAppDir}`,
          `--config.directories.output=${context.releaseDir}`,
        ],
        context,
      );
    } else if (!value.packaged) throw new Error('Missing verified isolated package');
    const verified = verify(context.bundlePath, context.buildDir, context.sourceRoot);
    if (reusePackage && verified.asarSha256 !== value.packaged.asarSha256)
      throw new Error('Packaged application does not match its artifact receipt');
    if (sourceFingerprint(context.sourceRoot) !== fingerprint)
      throw new Error('Source changed during artifact preparation');
    value.packaged = { asarSha256: verified.asarSha256 };
    save(context, value);
  }
  return { ...context, fingerprint };
}

export function loadArtifacts(root, { packaged = false } = {}) {
  return validateArtifacts(paths(root, repository), { packaged });
}

export function artifactOptions(args) {
  const options = {},
    values = args.filter((arg) => arg !== '--');
  for (let i = 0; i < values.length; i++) {
    const arg = values[i];
    if (arg === '--run-root') {
      const root = values[++i];
      if (!root || root.startsWith('--')) throw new Error('Missing --run-root value');
      options.root = root;
    } else if (arg === '--no-build') options.reuseBuild = true;
    else if (arg === '--no-package') options.reusePackage = true;
    else throw new Error(`Unknown artifact option: ${arg}`);
  }
  return options;
}

/** Real Vite dev has fresh output, rather than a reusable static-build receipt. */
export function devArguments(context, { port, automation = false, background = false } = {}) {
  const value = receipt(context);
  if (value.build || existsSync(context.buildDir)) throw new Error('Dev requires fresh output');
  return [
    'exec',
    'electron-vite',
    'dev',
    '--outDir',
    context.buildDir,
    '--entry',
    join(context.buildDir, 'main/index.js'),
    ...(port ? ['--remoteDebuggingPort', String(port)] : []),
    '--',
    ...(automation ? ['--data-agent-automation'] : []),
    ...(background ? ['--data-agent-background'] : []),
  ];
}
