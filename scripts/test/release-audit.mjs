import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { verifyRelease } from '../build/verify-release.mjs';

/** Retains the previous full release gate's package and process cleanup checks. */
export function auditRelease(dir, context) {
  const residuals = JSON.parse(
    execFileSync(
      resolve('runtime/darwin-arm64/python/bin/python3'),
      [
        '-I',
        '-B',
        '-c',
        `import psutil,sys,os,json
roots=[os.path.realpath(p) for p in sys.argv[1:]];found=[]
for p in psutil.process_iter(['pid','cmdline','cwd']):
 if p.pid in (os.getpid(),os.getppid()):continue
 try:
  args=p.info['cmdline'] or [];cwd=p.info['cwd'] or '';home=p.environ().get('DATA_AGENT_HOME','')
  if any(cwd.startswith(root+'/') or home.startswith(root+'/') or any(root+'/' in arg for arg in args) for root in roots):found.append({'pid':p.pid,'name':p.name()})
 except (psutil.NoSuchProcess,psutil.AccessDenied):pass
print(json.dumps(found))`,
        dir,
        context.root,
      ],
      { encoding: 'utf8' },
    ),
  );
  if (residuals.length) throw new Error(`Test process residuals: ${JSON.stringify(residuals)}`);
  return { residuals, release: verifyRelease(context.bundlePath, context.buildDir) };
}
