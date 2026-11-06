"""Pinned official release archive integrity and relocatable rg/fd verification."""
import hashlib,importlib.metadata,json,pathlib,shutil,subprocess,tarfile
ROOT=pathlib.Path(__file__).resolve().parent
OUT=ROOT/'artifacts/tools';OUT.mkdir(parents=True,exist_ok=True)
DEST=ROOT/'relocated/命令 工具';DEST.mkdir(parents=True,exist_ok=True)
FIX=DEST/'数据 文件';FIX.mkdir(exist_ok=True)
(FIX/'销售 明细.csv').write_text('地区,销售额\n华北,100\n华南,200\n')
EXPECTED={'ripgrep-15.2.0-aarch64-apple-darwin':('rg','3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4'), 'fd-v10.5.1-aarch64-apple-darwin':('fd','2d336895ed27b14c5cc9fc5eb22df03b3ee842b5dce80060e99d9cdc1b1b9fc7')}
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
results=[]
for folder,(tool,digest) in EXPECTED.items():
    archive=ROOT/'tool-downloads'/f'{folder}.tar.gz'
    assert sha(archive)==digest
    with tarfile.open(archive) as tf:tf.extractall(ROOT/'tools',filter='data')
    source=ROOT/'tools'/folder
    target=DEST/tool;shutil.copy2(source/tool,target)
    licenses=[p for p in source.iterdir() if p.name in ['LICENSE-MIT','LICENSE-APACHE','COPYING','UNLICENSE']]
    assert licenses
    license_dir=DEST/f'{tool}-licenses';license_dir.mkdir(exist_ok=True)
    for p in licenses:shutil.copy2(p,license_dir/p.name)
    env={'PATH':'/nonexistent','LC_ALL':'en_US.UTF-8'}
    version=subprocess.check_output([str(target),'--version'],env=env,text=True)
    arch=subprocess.check_output(['/usr/bin/file',str(target)],text=True)
    assert 'arm64' in arch
    deps=subprocess.check_output(['/usr/bin/otool','-L',str(target)],text=True)
    dependency_paths=[line.strip().split(' (')[0] for line in deps.splitlines()[1:]]
    assert all(p.startswith('/usr/lib/') or p.startswith('/System/Library/') for p in dependency_paths),deps
    if tool=='rg':
        output=subprocess.check_output([str(target),'--line-number','华北',str(FIX/'销售 明细.csv')],env=env,text=True)
        assert output=='2:华北,100\n'
    else:
        output=subprocess.check_output([str(target),'--absolute-path','--type','f','销售',str(FIX)],env=env,text=True)
        assert pathlib.Path(output.strip())==FIX/'销售 明细.csv'
    results.append({'tool':tool,'version':version.strip(),'archive_sha256':digest,'binary_sha256':sha(target),'binary_path':str(target),'file':arch.strip(),'dynamic_dependencies':dependency_paths,'output':output.strip(),'licenses':[{'path':str(license_dir/p.name),'sha256':sha(p)} for p in licenses]})
inventory=[]
for dist in importlib.metadata.distributions():
    files=[]
    for p in dist.files or []:
        if any(marker in pathlib.Path(p).name.lower() for marker in ['license','copying','notice']):
            real=pathlib.Path(dist.locate_file(p))
            if real.is_file():files.append({'path':str(real.relative_to(ROOT)), 'sha256':sha(real)})
    inventory.append({'package':dist.metadata['Name'],'version':dist.version,'metadata_license_expression':dist.metadata.get('License-Expression'),'metadata_license_field_present':bool(dist.metadata.get('License')),'preserved_license_files':files})
(OUT/'result.json').write_text(json.dumps({'status':'passed','tools':results,'scope':'Official release binaries copied to Chinese/space path, PATH nonexistent, system dylibs only; not a production Electron packaging assertion'},ensure_ascii=False,indent=2)+'\n')
(OUT/'dependency-license-inventory.json').write_text(json.dumps(inventory,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'status':'passed','tools':[{k:v for k,v in r.items() if k not in ['licenses','file','binary_path']} for r in results],'packages_without_license_files':[r['package'] for r in inventory if not r['preserved_license_files']]},ensure_ascii=False,indent=2))
