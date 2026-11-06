"""Own a tool process group and reap it on cancellation, parent loss or a limit.

stdin is a private Main-owned liveness pipe. It is never passed to the worker.
stdout is a framed protocol; arbitrary worker output is base64 encoded.
This is process lifecycle management, not a filesystem/network sandbox.
"""
import base64
import json
import os
import select
import signal
import subprocess
import sys
import time
import psutil

cancelled = False
def stop(_signum, _frame):
    global cancelled
    cancelled = True
signal.signal(signal.SIGHUP, signal.SIG_IGN)
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)

def emit(value):
    print(json.dumps(value), flush=True)

def identity(pid):
    try:
        return psutil.Process(pid).create_time()
    except psutil.Error:
        return None

def alive(pid, started):
    return started is not None and identity(pid) == started

def output_limit(root):
    if not root:
        return None
    if os.path.realpath(root) != root:
        return 'output_path_changed'
    total, count, directories = 0, 0, [root]
    while directories:
        with os.scandir(directories.pop()) as entries:
            for entry in entries:
                count += 1
                if count > 5000:
                    return 'output_entry_limit'
                if entry.is_symlink():
                    continue
                if entry.is_dir(follow_symlinks=False):
                    directories.append(entry.path)
                elif entry.is_file(follow_symlinks=False):
                    try:
                        total += entry.stat(follow_symlinks=False).st_size
                    except FileNotFoundError:
                        continue
                    if total > 500 * 1024**2:
                        return 'output_limit'
    return None

worker = None
reason = 'exit'
exit_code = None
try:
    # One bounded configuration line, then EOF means cancel. No shell interpolation here.
    raw = sys.stdin.buffer.readline(1024 * 1024)
    if not raw.endswith(b'\n'):
        raise ValueError('Invalid supervisor configuration')
    config = json.loads(raw)
    main_pid, host_pid = config['mainPid'], config['hostPid']
    main_identity, host_identity = identity(main_pid), identity(host_pid)
    if not alive(main_pid, main_identity) or not alive(host_pid, host_identity):
        raise ValueError('Parent is unavailable')
    initial_limit = output_limit(config.get('outputRoot'))
    if initial_limit:
        reason = initial_limit
        sys.exit(0)
    worker = subprocess.Popen(config['argv'], cwd=config['cwd'], env=config['env'],
                              stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              start_new_session=True, close_fds=True)
    emit({'type': 'started', 'pid': worker.pid, 'supervisorPid': os.getpid()})
    started = time.monotonic()
    peak = 0
    output_checked = 0
    streams = {worker.stdout.fileno(): 'stdout', worker.stderr.fileno(): 'stderr'}
    for fd in streams:
        os.set_blocking(fd, False)
    while True:
        if cancelled:
            reason = 'cancelled'; break
        if not alive(main_pid, main_identity) or not alive(host_pid, host_identity):
            reason = 'parent_exit'; break
        if time.monotonic() - started > min(config.get('timeoutSeconds', 180), 180):
            reason = 'timeout'; break
        if time.monotonic() - output_checked >= 0.25:
            output_checked = time.monotonic()
            limit = output_limit(config.get('outputRoot'))
            if limit:
                reason = limit; break
        try:
            parent = psutil.Process(worker.pid)
            rss = sum(p.memory_info().rss for p in [parent] + parent.children(recursive=True) if p.is_running())
            peak = max(peak, rss)
            if rss > 2 * 1024**3:
                reason = 'memory_limit'; break
        except psutil.Error:
            pass
        ready, _, _ = select.select([sys.stdin.fileno(), *streams], [], [], 0.05)
        if sys.stdin.fileno() in ready:
            if not os.read(sys.stdin.fileno(), 1):
                reason = 'cancelled'; break
            ready.remove(sys.stdin.fileno())
        for fd in ready:
            try:
                chunk = os.read(fd, 32 * 1024)
            except BlockingIOError:
                continue
            if chunk:
                emit({'type': 'output', 'stream': streams[fd], 'data': base64.b64encode(chunk).decode('ascii')})
            else:
                streams.pop(fd, None)
        exit_code = worker.poll()
        if exit_code is not None:
            limit = output_limit(config.get('outputRoot'))
            if limit:
                reason = limit
            # Drain available output, but never wait forever for a background descendant.
            for fd in list(streams):
                while True:
                    try:
                        chunk = os.read(fd, 32 * 1024)
                    except BlockingIOError:
                        break
                    if not chunk:
                        break
                    emit({'type': 'output', 'stream': streams[fd], 'data': base64.b64encode(chunk).decode('ascii')})
            break
except (BrokenPipeError, EOFError):
    reason = 'parent_exit'
except Exception:
    reason = 'supervisor_error'
finally:
    if worker:
        try: os.killpg(worker.pid, signal.SIGTERM)
        except ProcessLookupError: pass
        try: worker.wait(timeout=1)
        except subprocess.TimeoutExpired: pass
        try: os.killpg(worker.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        try: worker.wait(timeout=1)
        except subprocess.TimeoutExpired: pass
        try:
            emit({'type': 'finished', 'exitCode': exit_code if exit_code is not None else worker.returncode, 'reason': reason, 'peakRss': locals().get('peak', 0)})
        except BrokenPipeError:
            pass
    else:
        try: emit({'type': 'finished', 'exitCode': None, 'reason': reason, 'peakRss': 0})
        except BrokenPipeError: pass
