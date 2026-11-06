# Data Agent

支持数据分析工作的通用 AI 工作台，首版面向本机 macOS arm64。工作台负责文件路径、会话、模型与工具执行、审批和产物展示；分析方法与结果由 Agent 负责，不保证分析正确性。

## 当前状态

正式工程已实现桌面骨架、会话存储和 pi 通用工具链路：可管理会话、选择工作区、引用多个 CSV、配置内置模型与 BYOK、流式显示正文/思考/工具过程，并恢复原生 JSONL 历史。Python 执行、写入审批和澄清已接入，P4 已通过完整验收：支持版本化产物、Markdown/PNG 预览和整版导出，已跑通真实 DeepSeek 多 CSV 分析链路并完成独立 Judge 记录。后台/异常恢复与最终交付仍待 P5–P7 完成，当前不是完整 MVP。阶段状态见 [实施进度](docs/implementation-status.md)。`validation/` 仅为独立技术参考。

## 文档

- [产品说明](docs/mvp-plan.md)
- [技术设计与目录结构](docs/technical-design.md)
- [分阶段开发、程序验收与 Judge 效果评测](docs/development-plan.md)
- [版本管理与阶段提交规则](docs/repository-workflow.md)
- [可复用验证脚本](validation/README.md)

正式工程采用 pnpm；独立 Node 验证工程各用自己的 npm lockfile。正式工程按下方命令开发；尚未实现的阶段门禁会明确失败。运行结果、旧调研和一次性实验仅保留本地，不是检出仓库的前置依赖。

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
pnpm check
pnpm verify:phase -- P0
pnpm verify:phase -- P1
pnpm verify:phase -- P2  # 包含真实 DeepSeek 请求
pnpm verify:phase -- P3  # 工具/审批/CDP/内置运行时及真实模型
pnpm verify:phase -- P4  # 产物登记、预览、导出与真实多 CSV 链路
pnpm dev:cdp
```

阶段门禁会构建并实际启动 Electron，结果位于被忽略的 `test-results/`。`dev:cdp` 为开发助手开启独立测试实例，输出 CDP endpoint 和临时数据目录，Ctrl+C 退出；正常产品启动不开放 CDP。

本机打包：`pnpm package:dir`，产物位于 `release/mac-arm64/Data Agent.app`。打包前会校验内置运行时完整清单。现阶段含通用工具、内置 Python、审批及产物展示；最终交付仍以 P7 验收为准。

P2 的真实测试可单独运行 `pnpm test:integration:live`。测试脚本从继承环境或 `~/.zshrc` 的单条字面量赋值取得 `DEEPSEEK_API_KEY`，不会 source shell；通过实际设置页保存到隔离测试实例的系统加密存储。生产应用始终由用户在设置中填写 BYOK，不读取开发者 shell 文件。

P4 真实模型可能触发命令审批，含人工审核的运行使用 `DATA_AGENT_EVAL_REVIEW=1 pnpm verify:phase -- P4`。审核模式不会预先批准未知代码，详见 [评测说明](evaluations/README.md)。程序检查与 Judge 质量评价分开记录，评分不进入产品执行状态。
