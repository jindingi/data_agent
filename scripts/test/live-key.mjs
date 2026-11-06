import { execFileSync } from 'node:child_process';
/** Test runner only. Read one literal assignment; never source shell code or log the value. */
export function liveKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY;
  return execFileSync('python3', ['-c', `
import re, shlex
from pathlib import Path
key = None
for line in (Path.home() / '.zshrc').read_text().splitlines():
    if re.match(r'^\\s*(?:export\\s+)?DEEPSEEK_API_KEY\\s*=', line):
        words = shlex.split(re.sub(r'^\\s*(?:export\\s+)?', '', line), comments=True)
        if len(words) != 1 or not words[0].startswith('DEEPSEEK_API_KEY='):
            raise SystemExit('DEEPSEEK_API_KEY must be a simple literal assignment')
        key = words[0].split('=', 1)[1]
        if '$' in key or chr(96) in key:
            raise SystemExit('Nonliteral credential refused')
if not key:
    raise SystemExit('MISSING_DEEPSEEK_API_KEY; live test cannot be skipped')
print(key, end='')
`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
