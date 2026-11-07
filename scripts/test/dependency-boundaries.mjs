import { resolve, relative, dirname } from 'node:path';
import { builtinModules } from 'node:module';
import ts from 'typescript';
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
export function checkSource(file, text) {
  const problems = [];
  const config = ts.readConfigFile(resolve('tsconfig.json'), ts.sys.readFile);
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, resolve('.')).options;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const imports = [];
  function visit(node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      imports.push(node.moduleSpecifier.text);
    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        node.expression.getText(source) === 'require') &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      imports.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const specifier of imports) {
    const resolved = ts.resolveModuleName(specifier, resolve(file), options, ts.sys).resolvedModule
      ?.resolvedFileName;
    const path = resolved
      ? relative(resolve('src'), resolved)
      : specifier.startsWith('.')
        ? relative(resolve('src'), resolve(dirname(file), specifier))
        : specifier;
    const forbidden = file.startsWith('src/renderer/')
      ? /^(main|agent|node)\//
      : file.startsWith('src/shared/')
        ? /^(main|agent|node|preload|renderer)\//
        : file.startsWith('src/agent/')
          ? /^(main|renderer)\//
          : file.startsWith('src/main/')
            ? /^(agent|renderer)\//
            : /$a/;
    if (forbidden.test(path)) problems.push(`${file}: forbidden layer import ${specifier}`);
    if (
      (file.startsWith('src/renderer/') || file.startsWith('src/shared/')) &&
      (builtins.has(specifier) ||
        specifier === 'electron' ||
        specifier.startsWith('@earendil-works/'))
    )
      problems.push(`${file}: process dependency ${specifier}`);
  }
  return problems;
}
