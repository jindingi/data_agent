import { execFileSync } from 'node:child_process';
/** Test runner only. Read one literal assignment; never source shell code or log the value. */
export function liveKey(variable = 'DEEPSEEK_API_KEY') {
  if (!['DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY'].includes(variable))
    throw new Error('Unsupported live credential');
  if (process.env.DATA_AGENT_TEST_MODEL_MODE && process.env.DATA_AGENT_TEST_MODEL_MODE !== 'live')
    throw new Error('Real credentials are forbidden in non-live tests');
  if (process.env[variable]) return process.env[variable];
  return execFileSync(
    'python3',
    [
      '-c',
      `
import re, shlex
from pathlib import Path
key = None
for line in (Path.home() / '.zshrc').read_text().splitlines():
    if re.match(r'^\\s*(?:export\\s+)?${variable}\\s*=', line):
        words = shlex.split(re.sub(r'^\\s*(?:export\\s+)?', '', line), comments=True)
        if len(words) != 1 or not words[0].startswith('${variable}='):
            raise SystemExit('${variable} must be a simple literal assignment')
        key = words[0].split('=', 1)[1]
        if '$' in key or chr(96) in key:
            raise SystemExit('Nonliteral credential refused')
if not key:
    raise SystemExit('MISSING_${variable}; live test cannot be skipped')
print(key, end='')
`,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
}
