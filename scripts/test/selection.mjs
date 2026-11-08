import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import ts from 'typescript';
import { catalog, resolveCase, requirementsFor } from './case-registry.mjs';

const values = new Set(['case', 'feature', 'level', 'model', 'suite', 'base', 'run-root']);
const flags = new Set([
  'list',
  'dry-run',
  'affected',
  'live',
  'packaged',
  'no-build',
  'no-package',
  'unit',
  'integration',
  'e2e',
]);
export function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') continue;
    if (/^P\d+$/.test(arg)) {
      throw new Error(
        'Historical phase runners are retired; use --suite release --live for the complete gate, or --feature/--case for targeted tests.',
      );
    }
    const key = arg.replace(/^--/, '');
    if (arg.startsWith('--') && values.has(key)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value: ${arg}`);
      if (['case', 'feature'].includes(key))
        options[key] = [...(options[key] ?? []), ...value.split(',')];
      else options[key] = value;
    } else if (arg.startsWith('--') && flags.has(key)) options[key] = true;
    else throw new Error(`Unknown test option: ${arg}`);
  }
  for (const level of ['unit', 'integration', 'e2e']) if (options[level]) options.level = level;
  if (options.level && !['unit', 'integration', 'e2e', 'tooling'].includes(options.level))
    throw new Error('Unknown level');
  if (options.model && !['none', 'scripted', 'replay', 'live'].includes(options.model))
    throw new Error('Unknown model mode');
  if (options.suite && !['smoke', 'regression', 'release'].includes(options.suite))
    throw new Error('Unknown suite');
  return options;
}
export function changedFiles(base) {
  const git = (args) => execFileSync('git', args, { encoding: 'utf8' }).split('\0').filter(Boolean);
  return [
    ...new Set([
      ...git(['diff', '--name-only', '-z', `${base ?? 'HEAD'}...HEAD`]),
      ...git(['diff', '--name-only', '-z', 'HEAD']),
      ...git(['ls-files', '--others', '--exclude-standard', '-z']),
    ]),
  ];
}
const relatedPaths = [
  [
    /^src\/agent\/(session-runtime|agent-configuration|prompt-preview|workbench-session|input-identity|event-adapter|resource-loader|history|models)/,
    [
      'conversation',
      'usage',
      'models',
      'lifecycle',
      'artifacts',
      'transcript',
      'tools',
      'approvals',
      'composer',
    ],
  ],
  [/^src\/main\/services\/runtime/, ['conversation', 'usage', 'lifecycle', 'sessions']],
  [
    /^src\/main\/services\/(workspace|files)/,
    ['workspace', 'artifacts', 'preview', 'composer', 'conversation'],
  ],
  [/^src\/renderer\/features\/runtime\//, ['conversation', 'usage', 'transcript']],
  [/^src\/renderer\/features\/(workspace|artifacts)\//, ['workspace', 'preview', 'artifacts']],
  [/^src\/main\/services\/(policy|tools)/, ['approvals', 'tools', 'artifacts']],
];
/** Conservative transitive local-import graph plus cross-process feature ownership. */
export function affectedCases(files, entries = catalog) {
  const reasons = new Map();
  const add = (item, reason) => reasons.set(item.id, [...(reasons.get(item.id) ?? []), reason]);
  const config = ts.readConfigFile(resolve('tsconfig.json'), ts.sys.readFile);
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve('.')).options;
  const imports = new Map();
  function dependencies(file, seen = new Set()) {
    if (seen.has(file)) return seen;
    seen.add(file);
    if (!existsSync(file) || !/\.[cm]?[jt]sx?$/.test(file)) return seen;
    let targets = imports.get(file);
    if (!targets) {
      targets = [];
      const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), 99, true);
      function visit(node) {
        const spec =
          ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
            ? node.moduleSpecifier
            : ts.isCallExpression(node) &&
                (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                  node.expression.getText(sf) === 'require')
              ? node.arguments[0]
              : null;
        if (spec && ts.isStringLiteral(spec)) {
          let target = ts.resolveModuleName(spec.text, file, options, ts.sys).resolvedModule
            ?.resolvedFileName;
          if (!target && spec.text.startsWith('.')) target = resolve(dirname(file), spec.text);
          if (
            target &&
            !target.includes('/node_modules/') &&
            !relative(resolve('.'), target).startsWith('..')
          )
            targets.push(resolve(target));
        }
        ts.forEachChild(node, visit);
      }
      visit(sf);
      imports.set(file, targets);
    }
    for (const target of targets) dependencies(target, seen);
    return seen;
  }
  for (const path of files) {
    if (/^(docs\/|README\.md$)/.test(path)) continue;
    if (
      /^(src\/shared\/|src\/node\/|src\/preload\/|src\/main\/storage\/|src\/renderer\/(app|styles|components)\/|src\/main\/(index|ipc)|resources\/|scripts\/|tests\/(support|fixtures|catalog|legacy-aliases)|package|pnpm-lock|.*config\.|AGENTS\.md|\.github\/)/.test(
        path,
      )
    ) {
      entries.forEach((item) => add(item, `shared dependency: ${path}`));
      continue;
    }
    let found = false;
    for (const item of entries) {
      if (dependencies(resolve(item.file)).has(resolve(path))) {
        add(item, `imports: ${path}`);
        found = true;
      }
      for (const [pattern, features] of relatedPaths)
        if (
          pattern.test(path) &&
          (features.includes(item.feature) ||
            item.related.some((feature) => features.includes(feature)))
        ) {
          add(item, `feature boundary: ${path}`);
          found = true;
        }
    }
    if (path.startsWith('src/') && !relatedPaths.some(([pattern]) => pattern.test(path))) {
      // Native imports cannot reveal Renderer/IPC dependencies; unknown ownership is conservative.
      entries
        .filter((item) => item.level === 'e2e')
        .forEach((item) => add(item, `unmapped process boundary: ${path}`));
    }
    if (!found) entries.forEach((item) => add(item, `unmapped change (full regression): ${path}`));
  }
  return reasons;
}
export function selectTests(options, files) {
  let selected = catalog;
  const reasons = new Map();
  if (options.case) {
    const ids = options.case.map(resolveCase);
    for (const id of ids)
      if (!catalog.some((item) => item.id === id)) throw new Error(`Unknown test: ${id}`);
    selected = selected.filter((item) => ids.includes(item.id));
  }
  if (options.feature) {
    for (const feature of options.feature)
      if (!catalog.some((item) => item.feature === feature))
        throw new Error(`Unknown feature: ${feature}`);
    selected = selected.filter((item) => options.feature.includes(item.feature));
  }
  if (options.level) selected = selected.filter((item) => item.level === options.level);
  if (options.model) selected = selected.filter((item) => item.model === options.model);
  if (options.packaged) selected = selected.filter((item) => item.environment === 'packaged');
  if (options.live && !options.case && !options.suite && !options.model)
    selected = selected.filter((item) => item.model === 'live');
  if (!options.list && !options.case) {
    if (!options.live && options.model !== 'live')
      selected = selected.filter((item) => item.model !== 'live');
    if (!options.packaged && options.suite !== 'release' && !options.feature?.includes('packaging'))
      selected = selected.filter((item) => item.environment !== 'packaged');
    if (options.suite !== 'release' && !options.feature?.includes('performance'))
      selected = selected.filter((item) => !item.tags.includes('performance'));
  }
  if (!options.list && !options.case)
    selected = selected.filter((item) => !item.tags.includes('recording'));
  if (options.suite === 'smoke')
    selected = selected.filter(
      (item) => item.tags.includes('smoke') || ['unit', 'tooling'].includes(item.level),
    );
  if (options.affected) {
    const affected = affectedCases(files ?? changedFiles(options.base));
    selected = selected.filter((item) => affected.has(item.id));
    for (const [id, why] of affected) reasons.set(id, why);
  }
  if (!selected.length && !options.affected) throw new Error('No tests match the selection');
  return {
    tests: selected.map((item) => ({
      ...item,
      reasons: reasons.get(item.id) ?? ['explicit selector / suite'],
    })),
    requirements: requirementsFor(selected),
  };
}
