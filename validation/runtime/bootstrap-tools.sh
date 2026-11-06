#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mkdir -p "$ROOT/tool-downloads" "$ROOT/tools"
curl -fL https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-aarch64-apple-darwin.tar.gz -o "$ROOT/tool-downloads/ripgrep-15.2.0-aarch64-apple-darwin.tar.gz"
curl -fL https://github.com/sharkdp/fd/releases/download/v10.5.1/fd-v10.5.1-aarch64-apple-darwin.tar.gz -o "$ROOT/tool-downloads/fd-v10.5.1-aarch64-apple-darwin.tar.gz"
"$ROOT/python/cpython-3.12.12-macos-aarch64-none/bin/python3.12" -I -B "$ROOT/tools-probe.py"
