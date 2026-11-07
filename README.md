# Data Agent

支持数据分析工作的通用 AI 工作台，首版面向本机 macOS arm64。工作台负责文件路径、会话、模型与工具执行、审批和产物展示；分析方法与结果由 Agent 负责，不保证分析正确性。

## 当前状态

本机 macOS arm64 MVP 已完成 P0–P7。初次交付的完整 P7 门禁为 **61/61 通过**：全部前置确定性回归、实际 `.app` 的移动目录/离线运行、真实 DeepSeek 多 CSV 分析与重启追问、审批/停止/恢复及零残留进程；发布资源校验通过。此后增量修复的定向测试与清单变更另行记录，阶段与证据见 [实施进度](docs/implementation-status.md)。

打开 `release/mac-arm64/Data Agent.app`，在设置中填写 BYOK，即可引用 CSV 开始分析。支持多轮、插话、双会话并发、原生 JSONL 历史、Markdown/PNG 展示、复制及导出，Python 与常用库随包提供。详细操作见 [本机使用说明](docs/usage.md)。

Agent 效果独立评测，结果不保证正确：最终 J1/J5 为 8/12、10/12，记录了主图裁切和解释不严谨等问题。前期 J4/J6 曾耗尽请求预算，失败保留。其他模型、Intel/其他系统和公开签名公证尚未验收；本次交付是本机可用 `.app`。

交付后发现的预览滚动、空会话、附件状态、历史阅读与控件提示问题，见 [UX 修复计划](docs/ux-remediation-plan.md)。UX0–UX5 目前仅完成规划，尚未实施；原 P0–P7 通过记录不代表这些体验问题已修复。

## 文档

- [产品说明](docs/mvp-plan.md)
- [本机使用说明](docs/usage.md)
- [技术设计与目录结构](docs/technical-design.md)
- [AI 开发指南](AGENTS.md)
- [代码格式、Lint 与强制提交门禁](docs/code-quality.md)
- [软件工程审查与重构计划](docs/refactoring-plan.md)
- [设计原则与 AI 实施规范](docs/design-principles.md)
- [UX 修复阶段与验收计划（尚未实施）](docs/ux-remediation-plan.md)
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
pnpm verify:phase -- P0
pnpm verify:phase -- P1
pnpm verify:phase -- P2  # 包含真实 DeepSeek 请求
pnpm verify:phase -- P3  # 工具/审批/CDP/内置运行时及真实模型
pnpm verify:phase -- P4  # 产物登记、预览、导出与真实多 CSV 链路
pnpm verify:phase -- P5  # 多轮、并发、后台与恢复
pnpm verify:phase -- P6  # 边界、设置、性能、删除及真实多轮回归
pnpm verify:phase -- P7  # 全部确定性回归及实际 .app 的真实模型分析/恢复
pnpm verify:release     # 核对 .app 资源、hash、架构与许可证；与 P7 门禁组合使用
pnpm dev:cdp
```

阶段门禁会构建并实际启动 Electron，结果位于被忽略的 `test-results/`。`dev:cdp` 为开发助手开启独立测试实例，输出 CDP endpoint 和临时数据目录，Ctrl+C 退出；正常产品启动不开放 CDP。

依赖安装的 prepare 会设置 Husky。每次提交自动格式化/检查暂存文件，再跑全量 lint 和类型/架构检查；失败阻断提交。开发时可用 `pnpm format`、`pnpm lint:fix` 提前处理。Git hooks 不可用作跳过功能验收的理由，也不得用 `--no-verify` 绕过。现有代码已建立格式基线，App 与运行协调模块的职责拆分仍在重构计划中。

本机打包：`pnpm package:dir`，产物位于 `release/mac-arm64/Data Agent.app`。打包前会校验内置运行时完整清单。P7 已验证本机包内资源、实际 UI 流程与真实模型链路。

P2 的真实测试可单独运行 `pnpm test:integration:live`。测试脚本从继承环境或 `~/.zshrc` 的单条字面量赋值取得 `DEEPSEEK_API_KEY`，不会 source shell；通过实际设置页保存到隔离测试实例的系统加密存储。生产应用始终由用户在设置中填写 BYOK，不读取开发者 shell 文件。

P4 真实模型可能触发命令审批，含人工审核的运行使用 `DATA_AGENT_EVAL_REVIEW=1 pnpm verify:phase -- P4`。审核模式不会预先批准未知代码，详见 [评测说明](evaluations/README.md)。程序检查与 Judge 质量评价分开记录，评分不进入产品执行状态。
