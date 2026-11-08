#!/usr/bin/env python3
"""把模板、样式、脚本、数据与内置 ECharts 装配成单文件 report.html。

用法：
    python3 scripts/prepare_data.py     # 先整理数据（生成 derived/records.json）
    python3 scripts/build_report.py     # 再装配报告

所有路径都以本脚本所在位置为基准解析（工作区整体搬移后仍可运行）：
    <工作区>/src/template.html
    <工作区>/src/styles.css
    <工作区>/src/app.js
    <工作区>/derived/records.json
    <工作区>/vendor/echarts.min.js, LICENSE, NOTICE
输出：<工作区>/report.html
"""
from __future__ import annotations

import html
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
TEMPLATE = BASE / "src" / "template.html"
STYLES = BASE / "src" / "styles.css"
APP_JS = BASE / "src" / "app.js"
DATA = BASE / "derived" / "records.json"
VENDOR = BASE / "vendor"
OUT = BASE / "report.html"

MAX_BYTES = 32 * 1024 * 1024


def read(path: Path) -> str:
    if not path.exists():
        sys.exit(f"缺少文件：{path}。请先运行 scripts/prepare_data.py")
    return path.read_text(encoding="utf-8")


def main() -> None:
    template = read(TEMPLATE)
    styles = read(STYLES)
    app_js = read(APP_JS)
    data_text = read(DATA).replace("<", "\\u003c")
    echarts_js = read(VENDOR / "echarts.min.js")
    license_text = html.escape(read(VENDOR / "LICENSE"), quote=False)
    notice_text = html.escape(read(VENDOR / "NOTICE"), quote=False)

    replacements = {
        "/*APP_STYLES*/": styles,
        "/*APP_DATA*/": data_text,
        "/*ECHARTS_LIBRARY*/": echarts_js,
        "/*APP_JS*/": app_js,
        "/*VENDOR_LICENSE*/": license_text,
        "/*VENDOR_NOTICE*/": notice_text,
    }
    out = template
    for token, payload in replacements.items():
        if out.count(token) != 1:
            sys.exit(f"模板标记 {token} 出现 {out.count(token)} 次，应为 1 次")
        out = out.replace(token, payload)

    leftovers = [t for t in replacements if t in out]
    if leftovers:
        sys.exit(f"仍有未替换标记：{leftovers}")

    # 离线与可迁移性检查
    forbidden = ('src="http', "src='http", 'href="http', "href='http", "@import", "fetch(", "import(")
    hits = [f for f in forbidden if f in out]
    if hits:
        sys.exit(f"输出包含外部依赖片段：{hits}")
    if str(BASE) in out:
        sys.exit("输出包含绝对路径")

    payload = out.encode("utf-8")
    if len(payload) > MAX_BYTES:
        sys.exit(f"报告 {len(payload)} 字节，超过 32 MiB 限制")
    OUT.write_bytes(payload)
    print(f"已生成 {OUT.relative_to(BASE)}：{len(payload)/1024/1024:.2f} MB（UTF-8）")
    print(f"  数据快照 {len(data_text)/1024/1024:.2f} MB · 样式 {len(styles)/1024:.0f} KB · 脚本 {len(app_js)/1024:.0f} KB")
    print(f"  内置 ECharts {len(echarts_js)/1024:.0f} KB，NOTICE {len(notice_text)} B，LICENSE {len(license_text)} B")


if __name__ == "__main__":
    main()
