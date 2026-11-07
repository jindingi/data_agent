# Data Agent

支持数据分析工作的通用 AI 工作台，首版面向本机 macOS arm64。工作台负责文件路径、会话、模型与工具执行、审批和产物展示；分析方法与结果由 Agent 负责，不保证分析正确性。

## 当前状态

本机 macOS arm64 工作台已实现多轮对话、steer/follow-up、双会话并发、DeepSeek/OpenRouter 连接与模型选择、Agent 配置修订、原生 JSONL 历史、工作区文件浏览与预览。Python 与常用库随应用打包；原 CSV 直接引用，删除会话保留工作区文件。

SQLite 当前为 schema 12、6 张应用表，执行身份统一为 runId。完整字段、关系与会话/执行/输入/交互状态机见 [SQLite 表设计与状态机](docs/sqlite-design.md)。操作说明见 [本机使用说明](docs/usage.md)。

最近一次代码验收（`927bf9a`）普通回归 **87/87 通过**，包含隔离后台 Electron/CDP、原生集成和模型响应重放；这次未调用真实模型、未重新打包，不表示本机已有 release 包自动更新。测试入口与发布门禁见 [测试指南](docs/testing-guide.md)。历史过程记录从当前文档移除，必要时通过 Git 历史及本地 test-results 查询。

## 文档

- [产品说明](docs/mvp-plan.md)
- [本机使用说明](docs/usage.md)
- [技术设计与目录结构](docs/technical-design.md)
- [AI 开发指南](AGENTS.md)
- [按功能测试、定向回归与模型录制/重放](docs/testing-guide.md)
- [代码格式、Lint 与强制提交门禁](docs/code-quality.md)
- [软件工程审查与重构计划](docs/refactoring-plan.md)
- [设计原则与 AI 实施规范](docs/design-principles.md)
- [UX 修复阶段与验收计划](docs/ux-remediation-plan.md)
- [SQLite 表设计与状态机](docs/sqlite-design.md)
- [分阶段开发、程序验收与 Judge 效果评测](docs/development-plan.md)
- [版本管理与阶段提交规则](docs/repository-workflow.md)
- [可复用验证脚本](validation/README.md)

正式工程采用 pnpm；独立 Node 验证工程各用自己的 npm lockfile。正式工程按下方命令开发；阶段门禁遇到失败或缺失用例会明确失败。运行结果、旧调研和一次性实验仅保留本地，不是检出仓库的前置依赖。

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
pnpm verify:release                         # 仅资源检查，不等价于完整发布验收
pnpm dev:cdp
```

需要应用的功能测试会隔离构建并实际启动 Electron，结果位于被忽略的 `test-results/`。`dev:cdp` 为开发助手开启独立测试实例，输出 CDP endpoint 和临时数据目录，Ctrl+C 退出；正常产品启动不开放 CDP。

依赖安装的 prepare 会设置 Husky。每次提交自动格式化/检查暂存文件，再跑全量 lint 和类型/架构检查；失败阻断提交。开发时可用 `pnpm format`、`pnpm lint:fix` 提前处理。Git hooks 不可用作跳过功能验收的理由，也不得用 `--no-verify` 绕过。现有代码已建立格式基线，App 与运行协调模块已完成职责拆分。

本机打包：`pnpm package:dir`，产物位于 `release/mac-arm64/Data Agent.app`。打包前会校验内置运行时完整清单。P7 已验证本机包内资源、实际 UI 流程与真实模型链路。

真实只读对话可单独运行 `pnpm test:live -- --case models.live-conversation`。测试脚本从继承环境或 `~/.zshrc` 的单条字面量赋值取得 `DEEPSEEK_API_KEY`，不会 source shell；通过实际设置页保存到隔离测试实例的系统加密存储。生产应用始终由用户在设置中填写 BYOK，不读取开发者 shell 文件。

P4 真实模型可能触发命令审批，含人工审核的运行使用 `DATA_AGENT_EVAL_REVIEW=1 pnpm test:live -- --case artifacts.live-analysis`。审核模式不会预先批准未知代码，详见 [评测说明](evaluations/README.md)。程序检查与 Judge 质量评价分开记录，评分不进入产品执行状态。

自动验收默认隐藏窗口，不抢占桌面焦点；CDP 仍执行真实交互与截图。测试专用 `--data-agent-background` 仅改变窗口呈现，不授予自动化权限。
