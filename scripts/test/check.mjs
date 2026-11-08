import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { checkSource } from './dependency-boundaries.mjs';

const files = (dir) =>
  readdirSync(dir).flatMap((n) =>
    statSync(`${dir}/${n}`).isDirectory() ? files(`${dir}/${n}`) : [`${dir}/${n}`],
  );
const problems = [];
for (const file of files('src').filter((f) => /\.[cm]?[jt]sx?$/.test(f)))
  problems.push(...checkSource(file, readFileSync(file, 'utf8')));
for (const file of [
  'README.md',
  'AGENTS.md',
  ...files('docs').filter((p) => p.endsWith('.md') && !p.includes('/archived/')),
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
