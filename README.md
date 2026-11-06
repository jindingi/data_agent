# Data Agent

支持数据分析工作的通用 AI 工作台，首版面向本机 macOS arm64。工作台负责文件路径、会话、模型与工具执行、审批和产物展示；分析方法与结果由 Agent 负责，不保证分析正确性。

## 当前状态

目前已完成需求与技术设计，保留可复用的技术验证脚本；正式产品源码尚未开始实现。`validation/` 不是产品应用，也不是已完成的产品 E2E。

## 文档

- [产品说明](docs/mvp-plan.md)
- [技术设计与目录结构](docs/technical-design.md)
- [分阶段开发、程序验收与 Judge 效果评测](docs/development-plan.md)
- [版本管理与阶段提交规则](docs/repository-workflow.md)
- [可复用验证脚本](validation/README.md)

正式工程采用 pnpm；当前独立 Node 验证工程各用自己的 npm lockfile。请按对应 README 安装，不要在仓库根目录直接运行尚未实现的产品命令。运行结果、旧调研和一次性实验仅保留本地，不是检出仓库的前置依赖。
