"""Executable policy/approval feasibility probe, not a sandbox or production guard.

Run: python3 validation/policy/probe.py
All mutations are confined to a newly created temporary directory.
"""
from __future__ import annotations

import ast
import hashlib
import json
import re
import tempfile
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Context:
    workspace: Path
    private: Path
    sensitive: list[Path]
    published: set[Path] = field(default_factory=set)
    inputs: set[Path] = field(default_factory=set)


def inside(path: Path, root: Path) -> bool:
    return path.resolve().is_relative_to(root.resolve())


def path_decision(ctx: Context, action: str, raw: str) -> str:
    p = Path(raw)
    p = (p if p.is_absolute() else ctx.workspace / p).resolve()
    if inside(p, ctx.private) or any(inside(p, x) for x in ctx.sensitive):
        return 'deny'
    if action == 'read':
        return 'allow'
    if p in ctx.published:
        return 'deny'
    if p in ctx.inputs:
        return 'ask'
    return 'allow' if inside(p, ctx.workspace) else 'ask'


def combine(decisions: list[str]) -> str:
    return 'deny' if 'deny' in decisions else 'ask' if 'ask' in decisions else 'allow'


def script_decision(ctx: Context, source: str) -> tuple[str, list[str]]:
    """A deliberately bounded AST experiment for literal common Python operations.

    No imports are executed. Unresolved recognized writes ask. Unknown native/library
    side effects are NOT intercepted; that limitation is part of the test report.
    """
    try:
        tree = ast.parse(source)
    except SyntaxError:
        return 'ask', ['unparseable-script']
    values: dict[str, str] = {}
    decisions: list[str] = []
    reasons: list[str] = []

    def literal(node):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            return node.value
        if isinstance(node, ast.Name):
            return values.get(node.id)
        if isinstance(node, ast.BinOp):
            left, right = literal(node.left), literal(node.right)
            if left is not None and right is not None:
                if isinstance(node.op, ast.Add):
                    return left + right
                if isinstance(node.op, ast.Div):
                    return str(Path(left) / right)
        if isinstance(node, ast.Call) and name(node.func) in ('Path', 'pathlib.Path', 'str') and node.args:
            return literal(node.args[0])
        return None

    def name(node):
        if isinstance(node, ast.Name):
            return node.id
        if isinstance(node, ast.Attribute):
            return name(node.value) + '.' + node.attr
        return ''

    def record(action, node):
        raw = literal(node) if node is not None else None
        decisions.append(path_decision(ctx, action, raw) if raw is not None else 'ask')
        reasons.append(action + ':' + (raw or '<unresolved>'))

    # Restrict resolution to unconditional module-level constant assignments.
    for statement in tree.body:
        if isinstance(statement, ast.Assign):
            value = literal(statement.value)
            for target in statement.targets:
                if isinstance(target, ast.Name):
                    if value is None:
                        values.pop(target.id, None)
                    else:
                        values[target.id] = value
        for node in ast.walk(statement):
            if not isinstance(node, ast.Call):
                continue
            fn = name(node.func)
            leaf = fn.rsplit('.', 1)[-1]
            if fn in ('eval', 'exec', '__import__') or fn.startswith(('subprocess.', 'os.system', 'os.popen')):
                decisions.append('ask'); reasons.append('dynamic-execution')
            if fn.startswith(('requests.', 'urllib.request.', 'httpx.', 'socket.')):
                decisions.append('ask'); reasons.append('network')
            if fn in ('open', 'io.open') and node.args:
                mode = literal(node.args[1]) if len(node.args) > 1 else 'r'
                for kw in node.keywords:
                    if kw.arg == 'mode': mode = literal(kw.value)
                if mode is None:
                    decisions.append('ask'); reasons.append('unknown-open-mode')
                else:
                    record('write' if any(x in mode for x in 'wax+') else 'read', node.args[0])
            elif leaf in ('to_csv', 'savefig'):
                target = node.args[0] if node.args else next((kw.value for kw in node.keywords if kw.arg in ('path_or_buf', 'fname')), None)
                record('write', target)
            elif leaf in ('write_text', 'write_bytes', 'unlink', 'read_text', 'read_bytes') and isinstance(node.func, ast.Attribute):
                record('read' if leaf.startswith('read') else 'delete' if leaf == 'unlink' else 'write', node.func.value)
            elif fn in ('os.remove', 'os.unlink', 'shutil.rmtree'):
                record('delete', node.args[0] if node.args else None)
    return combine(decisions), reasons


def command_decision(command: str) -> str:
    """Regex classification only; never execute commands supplied to this function."""
    if not command.strip() or '\x00' in command or len(command) > 10_000:
        return 'deny'
    if re.search(r'\b(?:pip\d*|uv)\s+(?:pip\s+)?install\b|\bpython\S*\s+-m\s+pip\s+install\b', command):
        return 'deny'
    if re.search(r'\brm\s+-(?:[a-zA-Z]*r[a-zA-Z]*f|[a-zA-Z]*f[a-zA-Z]*r)\s+/\s*$|\bmkfs\b|\bdd\s+if=', command):
        return 'deny'
    if re.search(r'\b(?:curl|wget|ssh|scp|nc)\b|https?://|\$\(|`', command):
        return 'ask'
    return 'allow'


class ApprovalBroker:
    def __init__(self):
        self.pending = {}

    @staticmethod
    def digest(operation):
        return hashlib.sha256(json.dumps(operation, sort_keys=True).encode()).hexdigest()

    def request(self, approval_id, operation):
        self.pending[approval_id] = self.digest(operation)

    def consume(self, approval_id, operation, decision):
        expected = self.pending.pop(approval_id, None)
        return decision == 'allow_once' and expected is not None and expected == self.digest(operation)

    def cancel(self, approval_id):
        self.pending.pop(approval_id, None)


def main():
    results = []

    def check(name, actual, expected=True):
        if actual != expected:
            raise AssertionError(f'{name}: expected {expected!r}; actual {actual!r}')
        results.append({'id': name, 'passed': True})

    with tempfile.TemporaryDirectory(prefix='data-agent-policy-') as tmp:
        root = Path(tmp).resolve()
        work = root / 'workspace'
        external = root / 'external 中文'
        private = root / 'state'
        secret = root / 'fake-home/.ssh'
        for d in (work, external, private, secret): d.mkdir(parents=True)
        ctx = Context(work, private, [secret, root / 'fake-home/.zshrc'])
        (work / 'out-link').symlink_to(external, target_is_directory=True)
        check('external-read-allowed', path_decision(ctx, 'read', str(external / 'input.csv')), 'allow')
        check('sensitive-read-denied', path_decision(ctx, 'read', str(secret / 'key')), 'deny')
        check('control-files-denied', path_decision(ctx, 'write', str(private / 'state.sqlite')), 'deny')
        check('workspace-write-allowed', path_decision(ctx, 'write', '中文 目录/new.txt'), 'allow')
        check('external-write-asks', path_decision(ctx, 'write', str(external / 'new.txt')), 'ask')
        check('external-delete-asks', path_decision(ctx, 'delete', str(external / 'new.txt')), 'ask')
        check('prefix-sibling-asks', path_decision(ctx, 'write', str(root / 'workspace-other/file')), 'ask')
        check('symlink-new-child-asks', path_decision(ctx, 'write', 'out-link/new/file'), 'ask')
        check('dotdot-asks', path_decision(ctx, 'write', '../external 中文/file'), 'ask')
        src = external / 'source.csv'; src.write_text('value\n1\n')
        ctx.inputs.add(src)
        published = work / 'report-v1.md'; published.write_text('# Result\n')
        ctx.published.add(published)
        check('declared-input-write-asks', path_decision(ctx, 'write', str(src)), 'ask')
        check('published-version-write-denied', path_decision(ctx, 'write', str(published)), 'deny')
        check('new-version-allowed', path_decision(ctx, 'write', 'report-v2.md'), 'allow')
        broker = ApprovalBroker()
        target = external / 'approved.txt'
        op = {'sessionId': 'A', 'runId': 'r1', 'toolCallId': 't1', 'epoch': 'h1', 'rules': 1, 'path': str(target), 'script': 'write hello'}
        broker.request('a1', op)
        check('approval-does-not-execute-before-answer', target.exists(), False)
        if broker.consume('a1', op, 'allow_once'): target.write_text('hello')
        check('allow-once-executes', target.read_text(), 'hello')
        check('allow-cannot-replay', broker.consume('a1', op, 'allow_once'), False)
        for field in ('sessionId', 'runId', 'toolCallId', 'epoch', 'rules', 'path', 'script'):
            broker.request('changed', op)
            changed = {**op, field: 'different'}
            check('bound-' + field, broker.consume('changed', changed, 'allow_once'), False)
        broker.request('denied', op)
        check('deny-not-authorized', broker.consume('denied', op, 'deny'), False)
        broker.request('cancel', op); broker.cancel('cancel')
        check('late-answer-ignored', broker.consume('cancel', op, 'allow_once'), False)
        check('network-command-asks', command_decision('curl https://example.invalid/data.csv'), 'ask')
        check('dependency-install-denied', command_decision('python3 -m pip install example'), 'deny')
        check('danger-classified-not-executed', command_decision('rm -rf /'), 'deny')
        check('ordinary-command-allowed', command_decision('python analysis.py'), 'allow')
        examples = [
            ('ordinary-pandas-path', "out = Path('tables') / 'sales.csv'\ndf.to_csv(out)", 'allow'),
            ('outside-script-write', f"Path({str(external / 'x')!r}).write_text('x')", 'ask'),
            ('unresolved-script-write', 'df.to_csv(compute_path())', 'ask'),
            ('script-network', "requests.get('https://example.invalid/')", 'ask'),
            ('sensitive-script-read', f"Path({str(secret / 'key')!r}).read_text()", 'deny'),
            ('script-published-write', f"open({str(published)!r}, 'w')", 'deny'),
            ('dynamic-exec', 'exec(source)', 'ask'),
        ]
        for label, source, expected in examples:
            check(label, script_decision(ctx, source)[0], expected)
        # Validate TOCTOU rechecking: the stored tool parameters alone are insufficient.
        safe_link = work / 'changing'; safe_link.symlink_to(work, target_is_directory=True)
        check('before-symlink-swap', path_decision(ctx, 'write', 'changing/new'), 'allow')
        safe_link.unlink(); safe_link.symlink_to(external, target_is_directory=True)
        check('execution-time-recheck', path_decision(ctx, 'write', 'changing/new'), 'ask')
        check('source-file-unchanged', src.read_text(), 'value\n1\n')
    report = {
        'status': 'passed', 'cases': results, 'caseCount': len(results),
        'scope': 'Actual temporary-file/approval binding tests plus bounded command/AST classification; not pi-integrated product policy.',
        'limitations': [
            'Not a sandbox; dynamic aliases, imports, native code, races after recheck and opaque library side effects can evade static inspection.',
            'Regex shell probe does not implement a complete shell parser or path extraction.',
            'No dangerous command or external network request is executed.',
            'Production policy and malicious-data handling still need integration regression; this is feasibility evidence, not universal prevention.',
        ]
    }
    output = Path(__file__).parent / 'results.json'
    output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n')
    print(json.dumps({'status': report['status'], 'caseCount': len(results), 'report': str(output)}))


if __name__ == '__main__':
    main()
