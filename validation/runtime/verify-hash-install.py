"""Fresh wheel installation with strict hashes and intentional bad-hash rejection."""
import hashlib,json,os,pathlib,shutil,subprocess,sys,tempfile
ROOT=pathlib.Path(__file__).resolve().parent
OUT=ROOT/'artifacts/hash-install';OUT.mkdir(parents=True,exist_ok=True)
UV=shutil.which('uv');assert UV
env={**os.environ,'UV_CACHE_DIR':str(ROOT/'cache')}
with tempfile.TemporaryDirectory(prefix='fresh-hash-install-',dir=ROOT/'cache') as temp:
    target=pathlib.Path(temp)/'site-packages'
    cmd=[UV,'pip','install','--python',sys.executable,'--target',str(target),'--require-hashes','--only-binary',':all:','-r',str(ROOT/'requirements.hashed.lock')]
    install=subprocess.run(cmd,env=env,text=True,capture_output=True)
    (OUT/'install.log').write_text(install.stdout+install.stderr)
    assert install.returncode==0,install.stderr
    code='import sys,json;sys.path.insert(0,sys.argv[1]);import pandas,numpy,matplotlib,seaborn,jsonschema;print(json.dumps({m.__name__:{"file":m.__file__,"version":getattr(m,"__version__","unknown")} for m in [pandas,numpy,matplotlib,seaborn,jsonschema]}))'
    imports=json.loads(subprocess.check_output([sys.executable,'-I','-B','-c',code,str(target)],text=True))
    assert all(pathlib.Path(item['file']).is_relative_to(target) for item in imports.values())
    bad=pathlib.Path(temp)/'bad.txt';bad.write_text('attrs==26.1.0 --hash=sha256:'+'0'*64+'\n')
    negative=subprocess.run([UV,'pip','install','--python',sys.executable,'--target',str(pathlib.Path(temp)/'bad-install'),'--require-hashes','--only-binary',':all:','--no-deps','-r',str(bad)],env=env,text=True,capture_output=True)
    (OUT/'negative.log').write_text(negative.stdout+negative.stderr)
    assert negative.returncode!=0 and 'hash mismatch' in (negative.stdout+negative.stderr).lower(),negative.stderr
    result={'status':'passed','fresh_install_exit':install.returncode,'bad_hash_rejected':True,'bad_hash_exit':negative.returncode,'lock_sha256':hashlib.sha256((ROOT/'requirements.hashed.lock').read_bytes()).hexdigest(),'imports':imports,'scope':'21 pinned distributions, binary wheels only, fresh temporary target, required SHA256 hashes; temporary target removed after successful checks'}
    (OUT/'result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
