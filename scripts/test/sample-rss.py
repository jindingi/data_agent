"""Sample a running app's descendant RSS; no product hooks or result validation."""
import json
import sys
import time
import psutil

root = psutil.Process(int(sys.argv[1]))
identity = root.create_time()
try:
    while root.is_running() and root.create_time() == identity:
        app_rss = python_rss = 0
        for process in [root] + root.children(recursive=True):
            try:
                rss = process.memory_info().rss
                app_rss += rss
                if 'python' in process.name().lower():
                    python_rss += rss
            except psutil.Error:
                continue
        print(json.dumps({'time': time.time(), 'appRss': app_rss, 'pythonRss': python_rss}), flush=True)
        time.sleep(0.1)
except (psutil.Error, BrokenPipeError):
    pass
