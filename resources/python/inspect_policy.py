"""Bounded, non-executing recognition of common shell/Python side effects.

Output is evidence for a best-effort policy, never a proof that code is safe.
No source imports, functions, substitutions or expressions are executed.
"""
import ast
import json
import posixpath
import os
import re
import shlex
import sys

request = json.loads(sys.stdin.buffer.read(512 * 1024))
base = request.get('cwd', '')
result = {'accesses': [], 'scripts': [], 'sources': [], 'commands': [], 'network': [], 'dynamic': [], 'deny': []}

def access(action, path):
    if path is None:
        result['dynamic'].append('unresolved-' + action)
    else:
        if not path.startswith(('/', '~')):
            if base is None: result['dynamic'].append('unresolved-working-directory')
            else: path = posixpath.normpath(posixpath.join(base, path))
        result['accesses'].append({'action': action, 'path': path})

def shell(source):
    global base
    if not source.strip() or '\0' in source or len(source) > 100_000:
        result['deny'].append('invalid-command'); return
    # A quoted Python heredoc has no shell expansions; inspect its literal body as -c.
    # Unquoted, indented and complex heredocs remain explicit confirmation cases.
    source = re.sub(r'''\b(python(?:3(?:\.\d+)?)?)\s+-\s*<<\s*(['"])([A-Za-z_]\w*)\2[ \t]*\n(.*?)\n\3(?=\n|$)''',
                    lambda match: match[1] + ' -c ' + shlex.quote(match[4]), source, flags=re.DOTALL)
    if re.search(r'\b(?:sudo|mkfs|diskutil\s+erase|shutdown|reboot)\b|\bdd\s+if=|:\(\)\s*\{', source):
        result['deny'].append('destructive-command')
    if re.search(r'\b(?:pip\d*|uv|npm|pnpm|yarn|brew|conda|mamba|gem|apt|apt-get)\s+(?:pip\s+)?(?:install|add|update|upgrade)\b|\bpython\S*\s+-m\s+(?:pip|ensurepip)\b', source):
        result['deny'].append('dependency-install')
    if re.search(r'\$\(|`|\$\{|\beval\b|\b(?:source|exec)\b', source):
        result['dynamic'].append('shell-expansion-or-exec')
    try:
        lex = shlex.shlex(source, posix=True, punctuation_chars=';&|()<>\n')
        lex.whitespace = ' \t\r'
        lex.whitespace_split = True
        tokens = list(lex)
        if 'cd' in tokens and any(token in ('||', '(', ')') for token in tokens):
            result['dynamic'].append('conditional-or-subshell-cwd')
    except ValueError:
        result['dynamic'].append('unparsed-shell'); return
    for index, token in enumerate(tokens):
        if token == 'cd':
            before = tokens[index-1] if index else None
            after = next((part for part in tokens[index+1:] if re.fullmatch(r'[;&|()\n]+', part)), None)
            if before in ('|', '&') or after in ('|', '&'): result['dynamic'].append('pipeline-or-background-cwd')
    segments, current = [], []
    for token in tokens:
        if re.fullmatch(r'[;&|()\n]+', token):
            if current: segments.append(current); current = []
        else: current.append(token)
    if current: segments.append(current)
    for words in segments:
        filtered = []
        i = 0
        while i < len(words):
            word = words[i]
            if word in ('>', '>>', '>|', '<', '<>', '&>', '2>'):
                access('read' if word == '<' else 'write', words[i+1] if i+1 < len(words) else None); i += 2
            elif word in ('<<', '<<<'):
                result['dynamic'].append('heredoc-or-here-string'); i += 1
            else:
                filtered.append(word); i += 1
        while filtered and re.match(r'^[A-Za-z_]\w*=', filtered[0]):
            result['dynamic'].append('environment-assignment'); filtered.pop(0)
        if not filtered: continue
        command = filtered[0].rsplit('/', 1)[-1]
        args = filtered[1:]
        if command in ('curl', 'wget', 'ssh', 'scp', 'sftp', 'nc', 'netcat', 'telnet', 'ftp') or any(re.match(r'https?://', arg) for arg in args):
            result['network'].append(' '.join(filtered)[:2000])
        if command == 'git' and any(arg in ('clone', 'fetch', 'pull', 'push', 'ls-remote') for arg in args):
            result['network'].append(' '.join(filtered)[:2000])
        if command in ('curl', 'wget'):
            for index, arg in enumerate(args):
                if arg in ('-o', '--output', '-O', '--output-document'):
                    # curl -O chooses the remote basename; ask when no explicit target exists.
                    access('write', None if command == 'curl' and arg == '-O' else args[index+1] if index+1 < len(args) and not args[index+1].startswith('-') else None)
                elif arg.startswith(('--output=', '--output-document=')): access('write', arg.split('=', 1)[1])
        if command == 'cd':
            target = args[0] if len(args) == 1 else None
            if target and not re.search(r'[$`*?~]', target) and (base is not None or target.startswith('/')):
                base = posixpath.normpath(posixpath.join(base or '', target))
                access('read', base)
            else:
                result['dynamic'].append('changes-working-directory'); base = None
            continue
        if command in ('bash', 'sh', 'zsh'):
            if '-c' in args and args.index('-c') + 1 < len(args): result['commands'].append({'source': args[args.index('-c') + 1], 'cwd': base or request.get('cwd', '')})
            else: result['dynamic'].append('nested-shell')
        if re.match(r'^python(?:3(?:\.\d+)?)?$', command):
            if '-c' in args and args.index('-c') + 1 < len(args): result['sources'].append({'source': args[args.index('-c') + 1], 'cwd': base or request.get('cwd', '')})
            elif '-m' in args: result['dynamic'].append('python-module-execution')
            else:
                candidate = next((arg for arg in args if not arg.startswith('-')), None)
                if candidate:
                    if base is None and not candidate.startswith('/'): result['dynamic'].append('unresolved-script-cwd')
                    else: result['scripts'].append({'path': posixpath.normpath(posixpath.join(base or '', candidate)), 'cwd': base or request.get('cwd', '')})
                else: result['dynamic'].append('python-stdin')
        paths = [arg for arg in args if not arg.startswith('-')]
        if command == 'rm':
            for path in paths:
                if path in ('/', '/*', '~', '~/*'): result['deny'].append('destructive-root-delete')
                access('delete', path)
        elif command in ('touch', 'mkdir', 'rmdir', 'truncate', 'tee', 'chmod', 'chown'):
            for path in paths: access('write', path)
        elif command in ('cp', 'mv', 'install', 'ln'):
            if len(paths) < 2: result['dynamic'].append('unresolved-copy')
            else:
                for path in paths[:-1]: access('delete' if command == 'mv' else 'read', path)
                access('write', paths[-1])
        elif command in ('cat', 'head', 'tail', 'less', 'more', 'od', 'file', 'wc', 'md5', 'md5sum', 'sha256sum', 'shasum'):
            for path in paths: access('read', path)
        elif command == 'sed' and any(arg == '-i' or arg.startswith('-i') for arg in args):
            result['dynamic'].append('in-place-edit')
        # Literal sensitive paths are checked even for a command whose semantics are unknown.
        for arg in args:
            if arg.startswith(('/', '~/', './', '../')): access('read', arg)

def python(source):
    if len(source) > 256 * 1024:
        result['deny'].append('script-too-large'); return
    try: tree = ast.parse(source)
    except (SyntaxError, ValueError, RecursionError):
        result['dynamic'].append('unparsed-python'); return
    values, aliases = {}, {}
    def name(node):
        if isinstance(node, ast.Name): return aliases.get(node.id, node.id)
        if isinstance(node, ast.Attribute): return name(node.value) + '.' + node.attr
        return ''
    def literal(node):
        if isinstance(node, ast.Constant) and isinstance(node.value, str): return node.value
        if isinstance(node, ast.Name): return request.get('file') if node.id == '__file__' else values.get(node.id)
        if isinstance(node, ast.Attribute) and node.attr == 'parent':
            value = literal(node.value)
            return posixpath.dirname(value) if value is not None else None
        if isinstance(node, ast.JoinedStr):
            parts = [part.value if isinstance(part, ast.Constant) else literal(part.value) if isinstance(part, ast.FormattedValue) else None for part in node.values]
            return ''.join(parts) if all(isinstance(part, str) for part in parts) else None
        if isinstance(node, ast.BinOp):
            left, right = literal(node.left), literal(node.right)
            if left is not None and right is not None:
                if isinstance(node.op, ast.Add): return left + right
                if isinstance(node.op, ast.Div): return posixpath.join(left, right)
        if isinstance(node, ast.Call):
            fn = name(node.func)
            if fn in ('Path', 'pathlib.Path', 'str') and node.args: return literal(node.args[0])
            if fn in ('os.path.dirname', 'posixpath.dirname') and node.args:
                value = literal(node.args[0]); return posixpath.dirname(value) if value is not None else None
            if fn in ('os.path.abspath', 'os.path.realpath', 'posixpath.abspath') and node.args:
                value = literal(node.args[0]); return os.path.realpath(posixpath.join(base or '', value)) if value is not None and base is not None else None
            if fn in ('Path.cwd', 'pathlib.Path.cwd'): return base
            if isinstance(node.func, ast.Attribute) and node.func.attr in ('resolve', 'absolute') and not node.args:
                value = literal(node.func.value); return os.path.realpath(posixpath.join(base or '', value)) if value is not None and base is not None else None
            if fn in ('os.path.join', 'posixpath.join'):
                parts = [literal(arg) for arg in node.args]
                if all(part is not None for part in parts): return posixpath.join(*parts) if parts else ''
        return None
    for statement in tree.body:
        if isinstance(statement, ast.Import):
            for alias in statement.names: aliases[alias.asname or alias.name] = alias.name
        if isinstance(statement, ast.ImportFrom):
            for alias in statement.names: aliases[alias.asname or alias.name] = (statement.module or '') + '.' + alias.name
        if isinstance(statement, ast.Assign):
            for target in statement.targets:
                if isinstance(target, ast.Name):
                    value = literal(statement.value)
                    if value is None: values.pop(target.id, None)
                    else: values[target.id] = value
        for node in ast.walk(statement):
            if not isinstance(node, ast.Call): continue
            fn = name(node.func); leaf = fn.rsplit('.', 1)[-1]
            first = node.args[0] if node.args else None
            if fn in ('os.chdir', 'os.fchdir'): result['dynamic'].append('python-changes-directory')
            if fn in ('eval', 'exec', '__import__', 'compile'):
                result['dynamic'].append('dynamic-python')
            if fn.startswith(('pip.', 'ensurepip.')):
                result['deny'].append('dependency-install')
            if fn.startswith(('requests.', 'urllib.request.', 'httpx.', 'http.client.', 'socket.', 'aiohttp.')):
                result['network'].append(fn + ':' + str(literal(first) or '<dynamic>'))
            if fn.startswith('subprocess.') or fn in ('os.system', 'os.popen', 'os.execv', 'os.execve'):
                value = literal(first)
                if value is None and isinstance(first, (ast.List, ast.Tuple)):
                    parts = [literal(item) for item in first.elts]
                    if all(part is not None for part in parts): value = shlex.join(parts)
                if value is None: result['dynamic'].append('subprocess')
                else: result['commands'].append({'source': value, 'cwd': base or request.get('cwd', '')})
            if fn in ('open', 'io.open'):
                mode = literal(node.args[1]) if len(node.args) > 1 else 'r'
                for keyword in node.keywords:
                    if keyword.arg == 'mode': mode = literal(keyword.value)
                access('write' if mode is None or any(char in mode for char in 'wax+') else 'read', literal(first))
                if mode is None: result['dynamic'].append('open-mode')
            elif leaf in ('to_csv', 'to_json', 'to_excel', 'to_parquet', 'savefig'):
                target = first or next((kw.value for kw in node.keywords if kw.arg in ('path_or_buf', 'path', 'fname', 'excel_writer')), None)
                if target is not None: access('write', literal(target))
            elif leaf in ('read_csv', 'read_json', 'read_excel', 'read_parquet'):
                target = literal(first or next((kw.value for kw in node.keywords if kw.arg in ('filepath_or_buffer', 'path_or_buf', 'path', 'io')), None))
                if target and re.match(r'https?://', target): result['network'].append(target)
                else: access('read', target)
            elif leaf in ('write_text', 'write_bytes', 'unlink', 'read_text', 'read_bytes', 'mkdir', 'rmdir') and isinstance(node.func, ast.Attribute):
                access('read' if leaf.startswith('read') else 'delete' if leaf in ('unlink', 'rmdir') else 'write', literal(node.func.value))
            elif fn in ('os.remove', 'os.unlink', 'os.rmdir', 'shutil.rmtree'): access('delete', literal(first))
            elif fn in ('os.mkdir', 'os.makedirs'): access('write', literal(first))
            elif fn in ('os.rename', 'os.replace', 'shutil.move', 'shutil.copy', 'shutil.copy2', 'shutil.copyfile'):
                access('delete' if fn in ('os.rename', 'os.replace', 'shutil.move') else 'read', literal(first))
                access('write', literal(node.args[1]) if len(node.args) > 1 else None)

if request.get('mode') == 'shell': shell(request['source'])
elif request.get('mode') == 'python': python(request['source'])
else: raise ValueError('Unknown inspection mode')
if sum(len(value) for value in result.values()) > 4096: raise ValueError('Policy inspection too complex')
print(json.dumps(result))
