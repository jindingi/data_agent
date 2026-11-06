"""Run the authorized DeepSeek smoke with one literal key assignment, never sourcing the shell."""
import argparse
import os
import shutil
from pathlib import Path
import re
import shlex
import subprocess
import sys

parser = argparse.ArgumentParser(description='Run the reusable DeepSeek SDK smoke or audit local evidence.')
parser.add_argument('--audit-only', action='store_true')
args = parser.parse_args()

root = Path(__file__).resolve().parent
key = os.environ.get('DEEPSEEK_API_KEY')
if not key:
    for line in (Path.home() / '.zshrc').read_text().splitlines():
        if re.match(r'^\s*(?:export\s+)?DEEPSEEK_API_KEY\s*=', line):
            assignment = re.sub(r'^\s*(?:export\s+)?', '', line)
            words = shlex.split(assignment, comments=True)
            if len(words) != 1 or not words[0].startswith('DEEPSEEK_API_KEY='):
                raise SystemExit('Key assignment is not a simple literal; supply the environment variable explicitly.')
            key = words[0].split('=', 1)[1]
            if '$' in key or '`' in key:
                raise SystemExit('Nonliteral key assignment refused; supply the environment variable explicitly.')
if not key:
    raise SystemExit('DEEPSEEK_API_KEY is missing; test blocked, not skipped.')
allowed = ('PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy')
env = {k: os.environ[k] for k in allowed if k in os.environ}
env['DEEPSEEK_API_KEY'] = key
node = os.environ.get('VALIDATION_NODE') or shutil.which('node')
if not node and not args.audit_only:
    raise SystemExit('Node is missing; install a supported Node version or set VALIDATION_NODE.')
if args.audit_only:
    for artifact in (root / 'runs').rglob('*'):
        if artifact.is_file() and artifact.suffix in ('.json', '.jsonl', '.txt', '.md', '.py', '.csv') and key.encode() in artifact.read_bytes():
            raise SystemExit('Credential unexpectedly present in an evidence artifact.')
    print('Credential literal scan of evidence artifacts: passed.')
    raise SystemExit(0)
script = 'verify.mjs'
result = subprocess.run([node, str(root / script), '--live'], cwd=root, env=env, text=True, capture_output=True, timeout=200)
for artifact in (root / 'runs').rglob('*'):
    if artifact.is_file() and artifact.suffix in ('.json', '.jsonl', '.txt', '.md', '.py', '.csv') and key.encode() in artifact.read_bytes():
        raise SystemExit('Credential unexpectedly present in an evidence artifact; output suppressed.')
# Defensive final redaction before any process output reaches the terminal.
print(result.stdout.replace(key, '[REDACTED]'), end='')
print(result.stderr.replace(key, '[REDACTED]'), end='', file=sys.stderr)
print('Credential literal scan of evidence artifacts: passed.')
raise SystemExit(result.returncode)
