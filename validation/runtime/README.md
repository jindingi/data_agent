# 内置运行时准备与可复用检查

目标为 macOS arm64，需本机安装 uv（原探针使用 0.9.7）及 curl。下载 standalone CPython 3.12.12，不使用系统 Python 或系统 venv 作为随包运行时。

## 准备

从仓库根目录运行：

```sh
sh validation/runtime/bootstrap.sh
```

脚本安装 Python，以 `requirements.hashed.lock` 锁定 wheels 并验证 SHA-256，下载中文字体及许可证、验证字体 hash，确认分析库可导入，然后准备 rg/fd。`requirements.in` 保存直接依赖，requirements.lock 是版本清单，hashed lock 是实际安装依据。库版本变更须一并复核三份文件，不能绕过哈希校验。

字体使用 NotoSansCJKsc-Regular.otf，保留 SIL OFL 许可证。rg 15.2.0/fd 10.5.1 官方归档的版本、SHA-256、下载来源及许可获取写在 bootstrap-tools.sh/tools-probe.py。Python、fonts、tools、下载与缓存均只留本地，Electron 打包时从这些目录获取资源。

## 可重复检查

```sh
sh validation/runtime/bootstrap-tools.sh
validation/runtime/python/cpython-3.12.12-macos-aarch64-none/bin/python3.12 -I -B validation/runtime/verify-hash-install.py
```

- `tools-probe.py` 在中文/空格路径下使用 PATH=/nonexistent 检查 rg/fd、架构、系统动态库依赖，并登记许可证材料；应由本目录准备的 Python 执行。
- `verify-hash-install.py` 在新的临时目录严格按 hash 安装 wheels，检查导入来源，并验证错误 hash 被拒绝；需要联网/已有缓存，先执行 bootstrap。
- Electron 的 `check-packaged-resources.cjs` 进一步检查实际 `.app` 内 Python、库、字体与工具；本目录脚本不冒充打包验收。

生成的 artifacts/、relocated/、hash-install-test/ 等不提交。许可材料保存检查不等于法律审查。下载失败、hash 变化或缺少资源必须报错，不能改用未知镜像或默默回退系统运行时。

旧 run.py/probe.py/offline.py/run-offline.sh、销售 fixtures、metrics/manifest schema 与历史性能结果仅保留本地，不是运行上述命令的依赖，也不作为产品分析准确性的门禁。正式产品的性能/断网用例见 [测试指南](../../docs/testing-guide.md)，Judge 质量评测见 [评测说明](../../evaluations/README.md)。
