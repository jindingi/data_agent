#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
export UV_CACHE_DIR="$ROOT/cache"
export UV_PYTHON_INSTALL_DIR="$ROOT/python"
uv python install 3.12.12
PYTHON="$ROOT/python/cpython-3.12.12-macos-aarch64-none/bin/python3.12"
uv pip install --python "$PYTHON" --break-system-packages --require-hashes --only-binary :all: -r "$ROOT/requirements.hashed.lock"
mkdir -p "$ROOT/fonts"
curl -fL https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf -o "$ROOT/fonts/NotoSansCJKsc-Regular.otf"
curl -fL https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/LICENSE -o "$ROOT/fonts/LICENSE"
"$PYTHON" -I -B -c 'import hashlib,pathlib,sys; p=pathlib.Path(sys.argv[1]); assert hashlib.sha256(p.read_bytes()).hexdigest()=="2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b", "Font download hash changed; review the new asset before accepting it"' "$ROOT/fonts/NotoSansCJKsc-Regular.otf"
"$PYTHON" -I -B -c 'import pandas, numpy, matplotlib, seaborn; print("Bundled analysis libraries import successfully")'
sh "$ROOT/bootstrap-tools.sh"
