"""Disposable watchdog: independent parent, owns a dedicated worker process group."""
import os, sys, time, subprocess, signal, json, select
from pathlib import Path
main_pid, host_pid = map(int, sys.argv[1:3])
signal.signal(signal.SIGHUP, signal.SIG_IGN)
root, ident = Path(sys.argv[3]), sys.argv[4]
def alive(pid):
    try: os.kill(pid, 0); return True
    except ProcessLookupError: return False
heartbeat=root/f'{ident}.heartbeat'
child_code='import time,sys; f=open(sys.argv[1],"a",buffering=1)\nwhile True: f.write(str(time.time())+"\\n"); time.sleep(.1)'
worker_code='import subprocess,sys,time; subprocess.Popen([sys.executable,"-c",sys.argv[1],sys.argv[2]]); time.sleep(3600)'
child=subprocess.Popen([sys.executable,'-c',worker_code,child_code,str(heartbeat)],start_new_session=True,env={'PATH':'/usr/bin:/bin','PYTHONDONTWRITEBYTECODE':'1'})
info={'id':ident,'watchPid':os.getpid(),'childPid':child.pid,'mainPid':main_pid,'hostPid':host_pid,'python':sys.executable,'started':time.time()}
(root/f'{ident}.worker.json').write_text(json.dumps(info))
reason='worker_exit'
while child.poll() is None:
    # A private pipe is a stronger liveness signal than a PID (zombies/PID reuse).
    if select.select([sys.stdin], [], [], 0)[0] and os.read(sys.stdin.fileno(), 1) == b'':
        reason='main_exit'; break
    if not alive(main_pid): reason='main_exit'; break
    if not alive(host_pid): reason='host_exit'; break
    time.sleep(.1)
# Kill the entire group even if its initial worker exited: it may leave descendants.
try: os.killpg(child.pid, signal.SIGTERM)
except ProcessLookupError: pass
try: child.wait(timeout=1)
except subprocess.TimeoutExpired: pass
try: os.killpg(child.pid, signal.SIGKILL)
except ProcessLookupError: pass
info.update(reason=reason,finished=time.time(),returncode=child.poll())
(root/f'{ident}.reaped.json').write_text(json.dumps(info))
