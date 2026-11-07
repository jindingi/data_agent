import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { builtinModules } from 'node:module';
import ts from 'typescript';

const files = (dir) =>
  readdirSync(dir).flatMap((n) =>
    statSync(`${dir}/${n}`).isDirectory() ? files(`${dir}/${n}`) : [`${dir}/${n}`],
  );
const problems = [];
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
for (const file of files('src').filter((f) => /\.[cm]?[jt]sx?$/.test(f))) {
  const text = readFileSync(file, 'utf8');
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
    const path = specifier.startsWith('.')
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
}
for (const file of [
  'README.md',
  ...files('docs').filter(
    (p) => p.endsWith('.md') && !p.includes('/research/') && !p.endsWith('validation-report.md'),
  ),
]) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/\]\(([^)]+)\)/g)) {
    const link = match[1];
    if (/^https?:|^#/.test(link)) continue;
    if (!existsSync(resolve(dirname(file), link.split('#')[0])))
      problems.push(`${file}: broken link ${link}`);
  }
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('Dependency boundaries and documentation links passed.');
