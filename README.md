# Data Agent

支持数据分析工作的通用 AI 工作台，首版面向本机 macOS arm64。工作台负责文件路径、会话、模型与工具执行、审批和产物展示；分析方法与结果由 Agent 负责，不保证分析正确性。

## 当前状态

本机 macOS arm64 工作台已实现多轮对话、steer/follow-up、双会话并发、DeepSeek/OpenRouter 连接与模型选择、Agent 配置修订、原生 JSONL 历史、工作区文件浏览与预览。Python 与常用库随应用打包；原 CSV 直接引用，删除会话保留工作区文件。

SQLite 当前为 schema 12、6 张应用表，执行身份统一为 runId。完整字段、关系与会话/执行/输入/交互状态机见 [SQLite 表设计与状态机](docs/sqlite-design.md)。操作说明见 [本机使用说明](docs/usage.md)。交互 HTML 通过独立 skill、内置 ECharts 和隔离查看器提供。

测试入口与发布门禁见 [测试指南](docs/testing-guide.md)。每次执行的结果保存在本地 `test-results/`；历史计划、报告和研究保存在被 Git 忽略的 `docs/archived/`，旧的已提交内容可从 Git 历史恢复。历史通过记录不代表当前代码或现有安装包已完成验收。

## 文档

[文档索引](docs/README.md) 汇总持续维护的文档与对应代码入口。

- [产品说明](docs/product.md)
- [本机使用说明](docs/usage.md)
- [技术设计与目录结构](docs/technical-design.md)
- [AI 开发指南](AGENTS.md)
- [按功能测试、定向回归与模型录制/重放](docs/testing-guide.md)
- [代码格式、Lint 与强制提交门禁](docs/code-quality.md)
- [设计原则与 AI 实施规范](docs/design-principles.md)
- [SQLite 表设计与状态机](docs/sqlite-design.md)
- [独立 Agent 效果评测](evaluations/README.md)
- [版本管理与提交规则](docs/repository-workflow.md)
- [可复用验证脚本](validation/README.md)

正式工程采用 pnpm；独立 Node 验证工程各用自己的 npm lockfile。测试 runner 遇到失败或缺失用例会明确失败。运行结果、旧调研和一次性实验仅保留本地，不是检出仓库的前置依赖。

## 正式工程开发

需要 Node 22.22+、pnpm 10.14.0 和 macOS arm64。依赖与构建工具仅在开发机需要；交付应用会内置运行时。

```sh
pnpm install --frozen-lockfile
pnpm native:rebuild
pnpm runtime:prepare -- --download  # 首次准备内置运行时；构建机需 uv
pnpm dev
```

`pnpm native:rebuild` 确保 better-sqlite3 对应 Electron ABI，不使用系统 Node ABI 的二进制替代。默认安装下载官方 Electron，网络受限时应修复连接或使用已核对版本/hash 的官方缓存，不修改锁文件跳过完整性验证。

```sh
pnpm quality          # 格式、ESLint、TypeScript、依赖与文档检查
pnpm test:tooling     # 验证真实 Husky 提交钩子的通过/拒绝/部分暂存行为
pnpm test -- --feature usage
pnpm test -- --affected --base HEAD~1 --dry-run
pnpm test                                  # 普通确定性回归，含录制重放，不花模型 token
pnpm test:live -- --case conversation.live-cache
pnpm test -- --suite release                # 全部非 live 回归、性能与实际 .app
DATA_AGENT_EVAL_REVIEW=1 pnpm test -- --suite release --live
pnpm verify:release -- --run-root <产物目录> # 仅资源检查，不等价于完整发布验收
pnpm dev:cdp
```

需要应用的功能测试会隔离构建并实际启动 Electron，结果位于被忽略的 `test-results/`。`dev:cdp` 为开发助手开启独立、后台隐藏的测试实例，输出 CDP endpoint、产物上下文和临时数据目录，Ctrl+C 退出；正常产品启动不开放 CDP。

`pnpm build`、`pnpm dev`、`pnpm package:dir`、`pnpm dev:cdp` 与 `pnpm eval:prepare` 共用构建产物准备流程，默认在系统临时目录创建独立产物，不写共享 out/release。命令输出实际目录；可用 `--run-root <目录>` 指定新的独立位置。启动已构建版本使用 `pnpm start -- --run-root <产物目录>`，不猜测最近一次产物。复用须显式传入产物目录与 `--no-build`，复用包另加 `--no-package`；源码或产物变化、缺少校验记录均拒绝。开发热更新始终使用新目录，不复用静态构建。详细规则见 [测试指南](docs/testing-guide.md)。

依赖安装的 prepare 会设置 Husky。每次提交自动格式化/检查暂存文件，再跑全量 lint 和类型/架构检查；失败阻断提交。开发时可用 `pnpm format`、`pnpm lint:fix` 提前处理。Git hooks 不可用作跳过功能验收的理由，也不得用 `--no-verify` 绕过。现有代码已建立格式基线，App 与运行协调模块已完成职责拆分。

本机打包：`pnpm package:dir`，完成后输出实际 `bundlePath`（独立产物目录下的 `release/mac-arm64/Data Agent.app`），不会覆盖已有共享 release。打包前校验内置运行时，打包后比较实际包内代码、资源、许可及哈希；完整发布验收仍须按测试指南执行。

真实只读对话可单独运行 `pnpm test:live -- --case models.live-conversation`。测试脚本从继承环境或 `~/.zshrc` 的单条字面量赋值取得 `DEEPSEEK_API_KEY`，不会 source shell；通过实际设置页保存到隔离测试实例的系统加密存储。生产应用始终由用户在设置中填写 BYOK，不读取开发者 shell 文件。

真实分析可能触发命令审批，含人工审核的运行使用 `DATA_AGENT_EVAL_REVIEW=1 pnpm test:live -- --case artifacts.live-analysis`。审核模式不会预先批准未知代码，详见 [评测说明](evaluations/README.md)。程序检查与 Judge 质量评价分开记录，评分不进入产品执行状态。

自动验收默认隐藏窗口，不抢占桌面焦点；CDP 仍执行真实交互与截图。测试专用 `--data-agent-background` 仅改变窗口呈现，不授予自动化权限。
